// ==UserScript==
// @name         Polisvakt — Facebook-brygga
// @namespace    polisvakt
// @version      2.3
// @description  Läser nya inlägg i de Facebook-grupper du är medlem i och skickar polisvarningar vidare till Polisvakt.
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
 *   4. Fliken får ligga i BAKGRUNDEN, men det kostar fördröjning. Se
 *      "Ålder utan tidsstämpel" nedan — sedan version 2.2 mäter bryggan
 *      åldern på sin egen första observation i stället för att hovra fram
 *      Facebooks verktygstips, och då behövs varken muspekare eller
 *      förgrund. Kvar finns Chromes strypning av timers i dolda flikar:
 *      uppmätt tjugo sekunder mellan svepen de första två minuterna, sedan
 *      en enda väckning per minut. Mätningen står längst ner i filen.
 *
 * ÅLDER UTAN TIDSSTÄMPEL — varför bryggan slutade hovra
 *
 * Facebook renderar aldrig tidsstämpeln som text på nya inlägg; den är en
 * SVG-sprite utan aria-label. Fram till 2.1 var enda vägen till åldern att
 * hovra tidsstämpeln och läsa verktygstipset, vilket krävde förgrund och
 * dessutom är en tydlig automationssignal mot Meta.
 *
 * Men bryggan behöver inte Facebooks tidsstämpel för att veta att något är
 * nytt. Den sveper flödet var tjugonde sekund. Ett inlägg som inte fanns i
 * förra svepet men finns nu dök upp under det senaste svepet — bryggans
 * EGEN första observation är då en bättre tidsstämpel än den vi försöker
 * gissa ur DOM:en, och den gäller precis de inlägg som betyder något.
 *
 * Ordningen är alltså: Facebooks egen tid när den går att läsa (exaktast),
 * annars bryggans första observation, annars — bara om du slår på det —
 * hovring. Går ingen av vägarna fram skickas ingenting, precis som förut.
 *
 * Två saker gör observationen till ett bevis och inte en gissning, båda
 * motiverade i koden nedan: första svepet är ett KALIBRERINGSSVEP (allt som
 * syns då kan vara veckogammalt och får aldrig en observerad ålder), och
 * ett inlägg räknas som nytt bara om det dykt upp OVANFÖR något bryggan
 * redan känner igen (skrollning och färdigrendering lägger gamla inlägg
 * nedanför).
 *
 * Vill du se vad bryggan faktiskt får ut av flödet just nu:
 *   __polisvakt.tider()   → text, id, ålder och varifrån åldern kom
 *                            ('OLÄSLIG' om ingen väg gav en tid)
 *   __polisvakt.peek()    → hela avläsningen
 *   __polisvakt.forstSedda() → minneslistan över första observationer
 *   __polisvakt.grupper()    → de anslutna grupperna
 *   __polisvakt.aktivGrupp() → vilken av dem sidan visar just nu
 *   __polisvakt.hittaGrupper() → grupperna kontot är med i (kör på
 *                            facebook.com/groups/joins/)
 *
 * FLERA GRUPPER — nytt i 2.3
 *
 * Bryggan lyssnar på en LISTA av grupper, inte på en enda. Den som kör i
 * Stockholm ansluter Stockholmsgruppen, den som kör i Västerås sin. Tre
 * saker följer av det, och alla tre finns motiverade i koden:
 *
 *   • Varje grupp bär sin egen geografiska ruta. Utan den hade en
 *     Stockholmsvarning geokodats mot Västmanland och antingen kastats
 *     eller landat på fel gata med samma namn. Se CONFIG.groupIds.
 *   • Varje grupp har egen bokföring: dedupnycklar, först-sedd och
 *     kalibreringssvep. Samma mening i två grupper är två händelser.
 *   • Tom lista betyder fortfarande att skriptet vägrar starta.
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
     * DE ANSLUTNA GRUPPERNA. Bara inlägg i de här skickas vidare.
     *
     * Sedan 2.3 är det här en LISTA, inte ett fält. Skälet är att appen ska
     * gå att köra på fler orter än Västerås: den som kör i Stockholm ansluter
     * Stockholmsgruppen, den som kör i Göteborg sin. Varje grupp bär därför
     * sitt eget område — utan det hade en Stockholmsvarning geokodats mot
     * Västmanland och antingen kastats eller, värre, landat på fel gata med
     * samma namn.
     *
     * Formen på en rad:
     *
     *   {
     *     id:    '317968668373072',        // det som står efter /groups/
     *     namn:  'Här Står Polisen - Västerås',
     *     ort:   'Västerås',               // läggs till i geokodfrågan
     *     omrade:'Västmanland',            // bara för att känna igen texten
     *     ruta:  [15.10, 59.30, 17.30, 60.30],   // lonMin, latMin, lonMax, latMax
     *     notis: true,                     // valfritt, se nedan. Förval true.
     *   }
     *
     * ruta är gruppens geografiska avgränsning och är OBLIGATORISK så fort
     * det finns fler än en rad, eller så fort raden skrivs som ett objekt.
     * Se normaliseraGrupper() nedan för varför den regeln ser ut så.
     *
     * Tom lista betyder att skriptet vägrar starta. Förut betydde tomt fält
     * "läs varje grupp du besöker", med en varning i konsolen — men en
     * varning i konsolen är ingen spärr. Den som glömt fylla i fältet fick
     * en brygga som vidarebefordrade inlägg ur varenda grupp kontot är med
     * i, och det är precis det den aldrig får göra. Fel förval ska stoppa,
     * inte varna.
     *
     * Listan är enklast att låta appen skriva: Inställningar →
     * Facebook-grupper → "Kopiera inställning till bryggan".
     *
     *
     * DEN HÄR LISTAN ÄR SANNINGEN OM VILKA GRUPPER SOM LÄSES.
     *
     * Två program läser den, och båda läser exakt den här raden:
     *
     *   Användarskriptet    du sitter i det nu. Läser CONFIG.groupIds direkt.
     *   tools\brygg-daemon.ps1   klipper ut läsdelen ur den här filen och
     *                       plockar dessutom UT den här listan (se
     *                       Plocka-Grupper där) för att veta vilka flikar den
     *                       ska öppna och vilken ruta varje grupp har.
     *
     * Daemonen hade fram till 2.4 en EGEN uppfattning om geografin: den
     * injicerade ett naket groupId och fick då Västmanlands ruta för varje
     * grupp, oavsett vilken. En Stockholmsgrupp slog alltså upp "Sveavägen,
     * Västerås", fick tomt svar och loggade "okänd-plats" — tyst, och exakt
     * likt en lugn kväll. Två kopior av samma sanning driver isär; nu finns
     * bara den här.
     *
     * Appens inställningssida är INTE en tredje kopia. Den är en REDIGERARE:
     * den skriver aldrig något som körs, dess enda utgång är knappen
     * "Kopiera inställning till bryggan", och det den lägger i urklipp är
     * ordagrant den text som ska ersätta raderna nedan.
     *
     *
     * notis: false — kartan ja, push till låst skärm nej.
     *
     * Notisvägen på servern (fbmejl_push_mottagare i supabase\fbmejl.sql) har
     * ingen geografi alls: den skickar varje ny rapport till VARENDA
     * prenumerant. Med bara Västeråsgruppen ansluten spelade det ingen roll.
     * Ansluter man en grupp i en annan stad börjar Sergels torg dyka upp på
     * låsskärmen hos folk i Västerås, och det är en riktig produktskada.
     *
     * Tills rapportraden bär en region och notisurvalet filtrerar på den ska
     * en grupp utanför den egna staden ha notis: false. Då skrivs rapporten
     * med anon-nyckeln rakt till reports — den syns på kartan och i appens
     * röst — men den går aldrig genom fbmejl_ta_emot, och alltså aldrig ut
     * som push. Det är den ärliga mellanstationen, inte en tystad varning.
     */
    // "Här Står Polisen - Västerås", privat grupp, ~18 000 medlemmar.
    // Gruppen har inget eget namn i adressen, bara siffrorna — därför är
    // det den här formen som ska stå här, och samma form som Facebooks
    // notismejl kommer att bära.
    groupIds: [
      {
        id: '317968668373072',
        namn: 'Här Står Polisen - Västerås',
        ort: 'Västerås',
        omrade: 'Västmanland',
        ruta: [15.10, 59.30, 17.30, 60.30],
      },

      /*
       * STOCKHOLM — färdig att koppla in, avstängd med flit.
       *
       * Ta bort kommentarstecknen runt EN av raderna nedan och starta om
       * bryggan (tools\polisvakt-brygga.ps1). Daemonen öppnar då en andra
       * flik i samma bryggfönster och sveper båda grupperna i samma tick.
       *
       * VARFÖR DE LIGGER AVSTÄNGDA OCH INTE PÅSLAGNA:
       *
       *   1. Den grupp som faktiskt har volymen — 563061233834062,
       *      "Poliskontroller Stockholm", 32 561 medlemmar, ~45 inlägg i
       *      månaden mot Västeråsgruppens 24 — är PRIVAT, och ägaren är inte
       *      medlem. En privat grupp lämnar inte ut ett enda inlägg till en
       *      icke-medlem: sidan renderar, sessionen är inloggad, flödet är
       *      tomt. Att gå med är ägarens beslut, inte bryggans. Bryggan
       *      säger numera ifrån EN gång när en ansluten grupp aldrig ger
       *      något — se vakthunden i brygg-daemon.ps1 — i stället för att
       *      tiga.
       *   2. Den offentliga gruppen 280649102036931 GÅR att läsa utan
       *      medlemskap (mätt, riktig inläggstext hämtad). Men dess flöde är
       *      till stor del administratörens automatposter, så den reella
       *      takten är långt under de 31 inlägg i månaden som räknaren visar.
       *   3. Båda står med notis: false av skälet ovanför.
       *
       * Rutan är samma som appens "Stockholms län" i FB_REGIONER (js\app.js),
       * med flit: två tabeller som säger olika saker om samma län är samma
       * sorts fel som den här filen just slutade göra.
       */
      // {
      //   id: '563061233834062',
      //   namn: 'Poliskontroller Stockholm',
      //   ort: 'Stockholm',
      //   omrade: 'Stockholms län',
      //   ruta: [17.20, 58.80, 19.30, 60.20],
      //   notis: false,
      // },
      // {
      //   id: '280649102036931',
      //   namn: 'Var är polisen i Stockholms län?',
      //   ort: 'Stockholm',
      //   omrade: 'Stockholms län',
      //   ruta: [17.20, 58.80, 19.30, 60.20],
      //   notis: false,
      // },
    ],

    /*
     * Bakåtkompatibilitet. Fram till 2.2 hette fältet groupId och tog en
     * enda sträng. Står det något här och groupIds är tom används det, och
     * gruppen får då Västmanland som område — det är exakt vad fältet
     * betydde förut, och en tyst omtolkning till "hela Sverige" hade lagt
     * varningar var som helst på kartan.
     */
    groupId: '',

    minConfidence: 0.65,
    scanIntervalMs: 20000,

    /*
     * Mät åldern på bryggans egen första observation av inlägget.
     *
     * Facebook ritar tidsstämpeln som en SVG-sprite på inlägg som renderats
     * på klienten — alltså på precis de nya inlägg bryggan finns till för.
     * Där går tiden inte att läsa ur DOM:en alls. Men ett inlägg som saknades
     * i förra svepet och finns i det här dök upp under de senaste
     * scanIntervalMs millisekunderna, och det vet bryggan utan att fråga
     * Facebook. Nyckel plus tidpunkt sparas i localStorage så mätningen
     * överlever att fliken laddas om.
     *
     * Slår du av det här är du tillbaka i 2.1: bara inlägg vars tid råkar stå
     * som text, plus hovring om den är på.
     */
    firstSeenAge: true,

    /*
     * Hovra tidsstämpeln för att locka fram Facebooks verktygstips.
     *
     * AV som förval sedan 2.2, och det är ett medvetet byte. Hovringen var
     * enda vägen till åldern på ett SVG-sprite-inlägg, men den kostar tre
     * saker: fliken måste ligga i förgrunden med riktig layout, ett
     * verktygstips blinkar till på ägarens skärm, och muspekarhändelser på
     * rad är en automationssignal mot Meta. firstSeenAge ovan täcker samma
     * fall — nya inlägg — utan någon av kostnaderna, och är därför
     * förstahandsvalet.
     *
     * Kvar finns ett fall hovringen fortfarande löser: ett inlägg som redan
     * låg i flödet när fliken öppnades och vars tid inte går att läsa. Där
     * vet bryggan ingenting om åldern (se kalibreringssvepet nedan) och
     * hoppar över inlägget. Vill du ha med dem också, och accepterar
     * förgrundskravet, sätt den här till true. Hovringen sker bara på inlägg
     * som redan passerat parsern och saknar tid från de två billigare
     * vägarna, ett i taget, och städas bort efteråt.
     */
    hoverForTime: false,

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

  /* ================= De anslutna grupperna ================= */

  /*
   * Västmanland. Låg fram till 2.2 som en global VIEWBOX och var då hela
   * bryggans geografi. Nu är den bara förvalet för den gamla groupId-formen,
   * och siffrorna är oförändrade med flit: den som uppgraderar ska få exakt
   * samma avgränsning som förut, inte en ny som "borde" vara likvärdig.
   */
  const VASTMANLAND = { ort: 'Västerås', omrade: 'Västmanland',
                        ruta: [15.10, 59.30, 17.30, 60.30] };

  /*
   * Ord som står där ett grupp-id står i adressen, men som inte är grupper.
   * /groups/feed/ är det farliga: det är DITT samlade gruppflöde, alltså
   * inlägg ur varenda grupp kontot är med i. Läste bryggan där vore
   * gruppfiltret meningslöst.
   */
  const FORBJUDNA_GRUPPORD = new Set([
    'feed', 'discover', 'discovery', 'joins', 'create', 'search',
    'your_groups', 'category', 'browse', 'invites', 'notifications',
  ]);

  /** Plockar ut grupp-id:t ur allt från ett naket id till en hel adress. */
  function rensaGruppId(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    const m = /\/groups\/([^/?#\s]+)/i.exec(s);
    const bit = (m ? m[1] : s).trim();
    if (!/^[\w.-]+$/.test(bit)) return '';
    if (FORBJUDNA_GRUPPORD.has(bit.toLowerCase())) return '';
    return bit;
  }

  const giltigRuta = r =>
    Array.isArray(r) && r.length === 4 && r.every(n => Number.isFinite(n)) &&
    r[0] < r[2] && r[1] < r[3];

  /*
   * Från vad som än står i konfigurationen till en lista bryggan kan lita på.
   *
   * VARFÖR ETT OMRÅDE ÄR OBLIGATORISKT — utom i exakt ett fall
   *
   * En grupp utan område måste få något, och varje tänkbart förval är fel:
   * "Västmanland" lägger Stockholmsvarningar på Västeråskartan, "hela
   * Sverige" släpper igenom en träff på Storgatan i vilken stad som helst.
   * Alltså är rätt svar att vägra starta. Fel förval ska stoppa, inte varna.
   *
   * Undantaget är den gamla formen `groupId: '317968668373072'` — en naken
   * sträng, ensam. Den betydde Västmanland fram till 2.2, och att tolka om
   * den till något annat vid en uppgradering vore att ändra ägarens karta
   * bakom ryggen på honom. En naken sträng som ENSAM rad får därför
   * Västmanland; skrivs raden som ett objekt, eller finns det fler än en
   * rad, krävs ruta.
   *
   * @returns {{grupper: Array, fel: string|null}}
   */
  function normaliseraGrupper(ratt) {
    const rader = Array.isArray(ratt) ? ratt
      : (ratt == null || ratt === '') ? []
      : [ratt];

    const ut = [];
    const sedda = new Set();
    for (const rad of rader) {
      const bart = (typeof rad === 'string' || typeof rad === 'number');
      const kalla = bart ? { id: rad } : (rad && typeof rad === 'object' ? rad : null);
      if (!kalla) continue;

      const id = rensaGruppId(kalla.id);
      if (!id) continue;
      if (sedda.has(id)) continue;          // samma grupp två gånger = en grupp
      sedda.add(id);

      ut.push({
        id,
        bart,
        namn: String(kalla.namn || '').trim() || id,
        ort: String(kalla.ort || '').trim(),
        omrade: String(kalla.omrade || '').trim(),
        ruta: giltigRuta(kalla.ruta) ? kalla.ruta.map(Number) : null,
        /*
         * Förvalet är true, och det är inte en slarvig default. Fältet är
         * nytt i 2.4; varje befintlig rad saknar det, och de raderna ska
         * bete sig precis som förut. Att låta en saknad nyckel betyda
         * "skicka ingen notis" hade tystat Västeråsgruppen vid uppgradering
         * — det värsta tänkbara sättet att införa en ny inställning.
         */
        notis: (kalla.notis === undefined || kalla.notis === null) ? true : !!kalla.notis,
      });
    }

    if (!ut.length) return { grupper: [], fel: null };

    for (const g of ut) {
      if (g.ruta) continue;
      if (ut.length === 1 && g.bart) {      // gamla formen, oförändrad betydelse
        g.ruta = VASTMANLAND.ruta.slice();
        g.ort = g.ort || VASTMANLAND.ort;
        g.omrade = g.omrade || VASTMANLAND.omrade;
        continue;
      }
      return { grupper: [], fel:
        'gruppen ' + g.id + ' saknar område (ruta). Varje grupp måste säga var ' +
        'den ligger, annars hamnar en varning från en annan stad på din karta. ' +
        'Bryggan startar inte.' };
    }

    for (const g of ut) {
      // Orden används bara för att slippa skriva "Vasagatan, Västerås,
      // Västerås". Saknas de blir frågan bara lite längre, aldrig fel.
      g.orter = [g.ort, g.omrade].filter(Boolean).map(s => s.toLowerCase());
      delete g.bart;
    }
    return { grupper: ut, fel: null };
  }

  /*
   * groupIds vinner när den är ifylld, annars gäller det gamla groupId.
   * Ingen sammanslagning: två fält som båda gäller är två sanningar, och
   * den dagen de säger olika saker vet ingen vilken som styr.
   */
  const RATT = (CONFIG.groupIds != null && CONFIG.groupIds !== '' &&
                !(Array.isArray(CONFIG.groupIds) && !CONFIG.groupIds.length))
    ? CONFIG.groupIds : CONFIG.groupId;
  const { grupper: GRUPPER, fel: GRUPPFEL } = normaliseraGrupper(RATT);
  const gruppMedId = id => GRUPPER.find(g => g.id === id) || null;

  const TTL_MINUTES = { police: 45, control: 60, unmarked: 30 };
  const DEDUP_WINDOW_MS = 3 * 60 * 60 * 1000;
  const MAX_TRIES = 3;                            // innan ett inlägg ges upp
  const TAG = '[Polisvakt]';
  const HOVER_FORSOK = 12;                        // ~800 ms totalt på tipset
  const HOVER_PAUS_MS = 70;

  /* ================= Parser (kopia av js/parser.js) ================= */

  const TYPE_WORDS = [
    // Gruppordningen är numera bara tie-break. findType väger träffens
    // KVALITET först (exakt slår böjning slår sammansättning), annars hade
    // "Polisen står vid Hälla med kroppskameror" blivit en vägrad
    // kameraträff i stället för en polisvarning.
    { type: 'camera',   words: ['fartkamera', 'fartkameror', 'atk', 'trafiksäkerhetskamera',
                                // kamera->kameror är oregelbunden plural: "trafikkameror"
                                // slutar inte på "kamera". Därför står 'kameror' som eget ord.
                                'kamera', 'kameror',
                                // 'kamerasläp' och 'kameravagn' är huvudfinala på "släp"
                                // respektive "vagn", inte på "kamera" — ändelsematchningen
                                // når dem aldrig, precis som den inte når 'blåljusbil'.
                                // MOBILA_TYPORD nedan gör dem till kamera:'mobil' utan att
                                // något mobilord behöver stå bredvid.
                                'kamerasläp', 'kameravagn'] },
    { type: 'control',  words: ['trafikkontroll', 'fartkontroll', 'hastighetskontroll',
                                'laserkontroll', 'poliskontroll', 'kontroll', 'razzia', 'laser'] },
    { type: 'unmarked', words: ['civilbil', 'civilbilar', 'civilpolis', 'civilpoliser', 'civil polis',
                                'civila bilar', 'civil', 'civila'] },
    { type: 'police',   words: ['polis', 'polisen', 'poliser', 'polisbil', 'polisbilar', 'snut', 'snutar',
                                // 'blåljusbil' är huvudfinalt på "bil", inte på "blåljus", och
                                // kan därför inte härledas ur 'blåljus' med ändelsematchning.
                                'snuten', 'blåljus', 'blåljusbil', 'piket', 'mc-polis',
                                'motorcykelpolis'] },
  ];

  // Avblåsningsorden matchas ord mot ord även fortsättningsvis. Ett för brett
  // avblåsningsord skapar ingen rapport — det SLÄCKER en som finns.
  const CLEAR_WORDS = ['borta', 'åkte', 'åkt', 'iväg', 'försvunnit', 'försvann', 'fritt',
                       'lugnt', 'avblåst', 'packat', 'tomt'];

  /*
   * ORDMATCHNINGEN. Ordagrann kopia av js/parser.js — ändras den ena MÅSTE
   * den andra ändras likadant, annars tolkar bryggan och appen samma inlägg
   * olika. Hela motiveringen står i js/parser.js; kortversionen:
   *
   * Mätt i drift 2026-08-22: "Står en mobil trafikkamera vid första avfarten
   * Hälla" försvann tyst, för ordlistan hade 'kamera' och inlägget sade
   * 'trafikkamera'. Svenska sammansättningar är huvudfinala, alltså matchar
   * vi bakifrån: ett ord träffar ett listord om det SLUTAR på listordet,
   * eventuellt med en ändelse ur en sluten lista.
   *
   * Valt bort: delsträng (fångar "polisanmälan", "kameraövervakning",
   * "civilstånd"), prefixmatchning (fångar "kontrollera", "kontrollant") och
   * morfologibibliotek (mer kod än hela parsern, och varje fel blir en tyst
   * felmatchning i drift).
   */

  // Ingen -era, -erar, -erat, -erad, -ering: det är hela skillnaden mellan
  // "kontrollen" och "kontrollera". Tomma strängen = ren sammansättning.
  const BOJNINGAR = ['', 'n', 'en', 'et', 'er', 'ar', 'or', 'na', 'ns', 'ens', 'ets', 's',
                     'erna', 'arna', 'orna', 'ernas', 'arnas', 'ornas'];

  // 'atk' är tre bokstäver och en förkortning. 'laser' är värre: "blaser",
  // ASCII-formen av "blåser", SLUTAR på "laser" — ett blåsprov hade blivit en
  // trafikkontroll på kartan.
  const ENDAST_EXAKT = new Set(['atk', 'laser']);

  // "kontroll" är för generiskt för att bära en sammansättning:
  // biljettkontroll, parkeringskontroll, gränskontroll, fjärrkontroll. De vi
  // vill ha står redan som egna listord och får sina böjningar därifrån.
  //
  // Spärren gäller OCKSÅ böjningar. Den satt först bara i godkantForled,
  // alltså efter böjningsgrenen, och då matchade 'kontroll' plötsligt
  // "kontrollen" och "kontrollerna": "Föraren tappade kontrollen och körde av
  // vägen vid Tortuna" blev en publicerad trafikkontroll på en olycksplats.
  const INGEN_SAMMANSATTNING = new Set(['kontroll', 'kontroller']);

  // Kortare förled är oftast ingen sammansättning utan en bokstav som råkar
  // stå före ordet ("b" + "laser").
  const MIN_FORLED = 3;

  // Förled som gör sammansättningen till något annat. Kameraorden väger
  // tyngst: en kameraträff VÄGRAS, så ett falskt utslag där raderar en
  // rapport i stället för att skapa en. Foge-s stryks före uppslaget.
  const KAMERA_FEL_FORLED = [
    'övervakning', 'overvakning', 'säkerhet', 'sakerhet', 'webb', 'web', 'dash', 'back',
    'bak', 'front', 'vilt', 'jakt', 'kropp', 'mobil', 'telefon', 'video', 'action',
    'digital', 'system', 'reserv', 'drönar', 'dronar', 'film', 'foto', 'natur', 'fågel',
    'fagel', 'skol', 'butik', 'dörr', 'dorr', 'port', 'ring', 'spel',
  ];
  const FEL_FORLED = {
    kamera: KAMERA_FEL_FORLED,
    kameror: KAMERA_FEL_FORLED,
    fartkamera: KAMERA_FEL_FORLED,
    fartkameror: KAMERA_FEL_FORLED,
    'trafiksäkerhetskamera': KAMERA_FEL_FORLED,
    // "metropolis", "akropolis", "nekropolis" slutar på 'polis'.
    polis: ['metro', 'akro', 'nekro', 'necro', 'megalo', 'kosmo'],
  };

  function godkantForled(forled, listord) {
    // INGEN_SAMMANSATTNING testas överst i matchaOrd i stället, så att
    // spärren också gäller böjningsgrenen. Se motiveringen vid listan.
    const rent = forled.replace(/[-_]+$/, '');
    if (rent.length < MIN_FORLED) return false;
    const fel = FEL_FORLED[listord];
    if (!fel) return true;
    const utanFogeS = rent.endsWith('s') ? rent.slice(0, -1) : rent;
    return !fel.includes(rent) && !fel.includes(utanFogeS);
  }

  /*
   * Matchar ETT ord ur texten mot ETT listord.
   * Samma funktion används av findType och av extractPlace. Gick de isär
   * skulle "trafikkamera" bli både typ och plats: platsfrasen fick en
   * skräpsträng att geokoda OCH hela platsbonusen på +0,3, den enda term som
   * lyfter en rapport över tröskeln.
   * @returns {'exakt'|'bojning'|'sammansatt'|null}
   */
  function matchaOrd(ord, listord) {
    if (!ord || !listord) return null;
    if (ord === listord) return 'exakt';
    // Båda spärrarna står FÖRE böjningsloopen. Olika skäl, samma verkan här:
    // ett för generiskt eller för kort listord träffar bara sig självt.
    if (ENDAST_EXAKT.has(listord) || INGEN_SAMMANSATTNING.has(listord)) return null;

    let basta = null;
    for (const andelse of BOJNINGAR) {
      const form = listord + andelse;
      if (ord.length < form.length) continue;
      if (ord === form) return 'bojning';        // andelse kan aldrig vara '' här
      if (!ord.endsWith(form)) continue;
      if (godkantForled(ord.slice(0, ord.length - form.length), listord)) basta = 'sammansatt';
    }
    return basta;
  }

  /*
   * Exakt ord eller böjning av det — men aldrig en sammansättning.
   *
   * Egen jämförelse, INTE matchaOrd. Skillnaden är avsiktlig: matchaOrd bär
   * typordens spärrar (ENDAST_EXAKT, INGEN_SAMMANSATTNING) som ska hålla
   * nätet som SKAPAR rapporter smalt, medan den här används av
   * nykterhetsspärren, som ska vara bred. Gick de via samma väg skulle
   * 'kontroll' i INGEN_SAMMANSATTNING tyst släppa igenom "drog kontrollen".
   */
  const arBojningAv = (ord, bas) => {
    if (!ord || !bas) return false;
    if (ord === bas) return true;
    return BOJNINGAR.some(a => a && ord === bas + a);
  };

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
    // Blås-orden utan svenska tecken. "sallnings" fick sin ASCII-form när
    // narkotikaorden lades till, men blås-orden glömdes — "blaser i
    // vasteras" gick igenom medan "blåser i Västerås" stoppades. Samma
    // mening, olika tangentbord. "blas" ensamt är för kort och för nära
    // vanliga ord; böjningarna räcker. Se js/parser.js.
    'blaser', 'blasa', 'blaste', 'blasning', 'blåsning',
  ];

  /*
   * Stavningar som fångas var de än står. Se motiveringen i js/parser.js.
   * "drog" saknas med flit — det är också imperfekt av "dra", och
   * "polisen drog vidare" är en avblåsning, inte en kontroll.
   */
  const SOBRIETY_STAMMAR = [
    // 'nyckter' är felstavningen av 'nykter'. Den är inget svenskt ord och
    // kostar därför ingenting; utan den gick "Nyckterhetsrazzia vid Bäckby"
    // förbi hela stamlistan.
    'nykter', 'nyckter', 'alkohol', 'alko', 'promille', 'rattfyll',
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
  /*
   * Huvudorden matchas med arBojningAv(), inte med exakt likhet.
   *
   * MÄTT HÅL, samma dag som kameran försvann: "Polisen har drog kollen på
   * E18" blev en vanlig polisrapport. 'drog' är med flit inget stamord, och
   * 'kollen' fanns inte i listan — bara 'koll'. Bestämd form saknades
   * genomgående: kontrollen, kontrollerna, testet, provet, kollen.
   * Böjningslistan täcker dem alla och växer med typorden i stället för att
   * halka efter dem.
   *
   * VARFÖR LISTAN VÄXTE I SAMMA ÄNDRING SOM TYPORDEN
   *
   * Reglerna nedan finns i praktiken bara för ordet 'drog' — alla andra
   * förled är också stammar och fångas en rad tidigare. Frågan är alltså:
   * vilket ord efter "drog" gör det till en drogkontroll? Listan hade sex
   * svar och behövde fler, för breddningen av typorden gav dem betydelse:
   * 'razzia' står som typord i control-gruppen, så "Drograzzia vid Erikslund"
   * blev en publicerad kontroll med notis där samma mening förut gav
   * ingenting alls. Samma sak för drogpolisen ('polis') och drogpiketen
   * ('piket'). Serverns migration hade redan pekat ut razzia, sök och hund.
   *
   * PRISET, uträknat och accepterat: "Nu drog polisen från Erikslund" vägras.
   * Det är en AVBLÅSNING som tystnar — en varning som ligger kvar sin TTL ut,
   * aldrig en varning som uteblir. Riktningen är hela regeln.
   */
  const SOBRIETY_HEAD = ['kontroll', 'kontroller', 'test', 'prov', 'kollar', 'koll',
                         'razzia', 'sök', 'sok', 'hund', 'polis', 'poliser', 'piket'];

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
    // Räkneorden kom med driftfallet: "vid FÖRSTA avfarten Hälla" gav
    // platsen "första hälla", som ingen geokodning hittar.
    'första', 'andra', 'tredje', 'fjärde', 'femte', 'sista',
    'man', 'du', 'ni', 'jag', 'vi', 'kommer', 'kör', 'åker', 'svänger', 'sväng', 'av',
    // Tidsorden och de vanligaste fyllnadsorden. De är aldrig en plats, och
    // förr blev de det: "Poliskontroll idag som ligger vid Hälla" gav platsen
    // "idag", eftersom ordet både överlevde rensningen och utlöste
    // bisatsgränsen innan ortnamnet hann läsas.
    'idag', 'dag', 'imorgon', 'ikväll', 'inatt', 'igår', 'pågår', 'ute', 'fortfarande',
    // Klockan skrivs ut lika ofta som den skrivs med siffror. Siffrorna tas
    // om hand av klockslagsregeln i extractPlace, orden här.
    'kl', 'klockan',
    // Ur det mätta inlägget "Polis för andra gången idag Emausskolan 13.45
    // stan". 'andra' och 'idag' fanns redan; 'för' och 'gången' följde med in
    // i platsfrasen och gjorde den oslagbar.
    'för', 'gången', 'gånger', 'till',
    // Fler verb i samma familj som 'står'/'kör'. Ett verb är aldrig en plats,
    // och riktningen är ofarlig: ett ord för mycket här kan bara göra
    // platsfrasen kortare, aldrig fel.
    'stannar', 'stannat', 'passerar', 'passerade',
  ]);

  /*
   * Ord som inleder en bisats. Efter dem beskriver meningen något annat än
   * var polisen står: "...avfarten Hälla OM MAN KOMMER FRÅN STOCKHOLM".
   * Gränsen gäller bara när vi redan fått något att gå på — "Polisen SOM står
   * vid Hälla" börjar med bisatsordet, och där är det bara ett stoppord.
   */
  const KLAUSULORD = new Set(['om', 'när', 'ifall', 'eftersom', 'medan', 'som', 'men']);

  /*
   * Ord som gör en kamera flyttbar. Se kameraregeln i parseReportText.
   * Exakta ord med flit, ingen prefixmatchning: "jag såg den i mobilen"
   * skulle annars göra varje fast fartkamera till en mobil.
   *
   * ORDET MÅSTE STÅ INTILL KAMERAORDET. Regeln letade först efter dem var som
   * helst i inlägget, och ett enda räckte för att göra en FAST kamera till en
   * publicerad trafikkontroll med 60 minuters TTL och röstnotis:
   *   "Fartkameran vid Bäckby blixtrade, jag har bilden i min mobil"
   *   "Nya fartkameran vid Erikslund, se den tillfälliga skylten"
   *   "Trafikkameran vid Skiljebo, jag stod med släpet bakom"
   * Alla tre mättes över tröskeln 0,65. På avstånd från kameraordet betyder
   * orden något helt annat — telefonen, skylten, släpet bakom bilen.
   */
  const MOBIL_KAMERA_ORD = new Set([
    'mobil', 'mobila', 'mobilt', 'flyttbar', 'flyttbara', 'flyttbart',
    'tillfällig', 'tillfälliga', 'tillfälligt', 'skåpbil', 'skåpbilen',
    'släpvagn', 'släpet', 'kameravagn', 'kamerasläp', 'trailer',
  ]);

  // Står något av dem intill kameraordet är kameran fast, hur många mobilord
  // som än står längre bort i meningen.
  const FAST_KAMERA_ORD = new Set(['fast', 'fasta', 'fastmonterad', 'fastmonterade']);

  // Listord som ÄR en mobil kamera i sig — inget grannord behövs.
  const MOBILA_TYPORD = new Set(['kamerasläp', 'kameravagn']);

  // Hur långt från kameraordet ett mobilord får stå. Två ord, inte ett:
  // "fartkamera I skåpbil" och "kamera PÅ ETT släp" har småord emellan.
  const KAMERA_FONSTER = 2;

  /** Står något ord ur mängden inom fönstret runt ordet på plats idx? */
  function narOrdet(words, idx, mangd) {
    if (!(idx >= 0)) return false;
    const forsta = Math.max(0, idx - KAMERA_FONSTER);
    const sista = Math.min(words.length - 1, idx + KAMERA_FONSTER);
    for (let i = forsta; i <= sista; i++) {
      if (i !== idx && mangd.has(words[i])) return true;
    }
    return false;
  }

  // Böjningarna står utskrivna: matchningen är exakt strängmatchning, så
  // 'korsningen' hjälper inte "Hammarby korsning".
  const DIRECTION_HINTS = new Set(['norrut', 'söderut', 'österut', 'västerut', 'infart', 'avfart',
    'påfart', 'avfarten', 'påfarten', 'infarten', 'rondellen', 'rondell', 'korsningen', 'korsning',
    'bron', 'bro', 'rampen', 'ramp', 'viadukten', 'viadukt', 'trafikplatsen', 'trafikplats',
    'cirkulationsplatsen', 'cirkulationsplats']);

  const NOT_A_PLACE = new Set([
    ...CLEAR_WORDS, 'ihop',
    'hej', 'hallå', 'okej', 'vakt', 'hey',
    'mörk', 'mörkblå', 'ljus', 'vit', 'svart', 'grå', 'blå', 'röd', 'silver',
    'bil', 'bilen', 'skåpbil', 'volvo', 'passat', 'golf', 'bmw', 'audi', 'buss',
    // Beskriver utrustningen, inte platsen: "en MOBIL trafikkamera vid Hälla".
    ...MOBIL_KAMERA_ORD, ...FAST_KAMERA_ORD,
    // 'kontroll' står i INGEN_SAMMANSATTNING och plockas därför inte längre
    // bort av arTypord i böjd form. Utan de här raderna hamnar "kontrollen" i
    // platsfrasen som geokodningen får slå upp.
    'kontroll', 'kontrollen', 'kontroller', 'kontrollerna',
  ]);

  /*
   * Ord som gör inlägget till gruppens eget prat i stället för en observation.
   *
   * Gruppens NAMN innehåller ett typord ("Här Står Polisen - Västerås"). Varje
   * jubileums-, välkomst- och regelinlägg som citerar namnet får därför en
   * typordsträff gratis. Mätt 2026-08-22: "Idag firar Här Står Polisen -
   * Västerås 12 år med 18K följare" gav report/police med tilliten 0,80 — över
   * tröskeln 0,65 — och räddades bara av att geokodningen inte hittade
   * skräpsträngen. Det är en systematisk källa till falska varningar, inte en
   * slumpmässig, och den blir farligare i samma stund som platsuttaget blir
   * bättre.
   *
   * Kontrollen är medvetet oberoende av inläggets längd, till skillnad från
   * NOISE_WORDS ovan som bara gäller under fem ord: metainläggen är långa.
   * Inget av orden förekommer i en observation av polis.
   */
  const GRUPPMETA_ORD = ['firar', 'firade', 'jubileum', 'följare', 'medlemmar', 'medlem',
    'gruppen', 'gruppens', 'admin', 'administratör', 'moderator', 'välkommen', 'välkomna',
    'regler', 'reglerna', 'påminnelse', 'inlägg', 'inlägget',
    // Gruppens egen regeltext lyder "Man skriver enbart när man ser en
    // poliskontroll." och gav report/control med tilliten 0,95 varje gång en
    // administratör klistrade in den. Ingen som rapporterar polis skriver
    // "skriver".
    'skriver', 'skriv', 'skrivs'];

  /* ---- Platsen ensam är en varning -------------------------------------- */

  /*
   * GRUPPENS KONVENTION, OCH VARFÖR DEN FÅR STYRA
   *
   * "Här Står Polisen - Västerås" har en enda regel på sin om-sida: "Man
   * skriver enbart när man ser en poliskontroll." Följden är att folk skriver
   * bara platsen, ibland med ett klockslag eller en färdriktning:
   *     Dillos norrgående 11.15
   *     Hemköp Öster Mälarstrand- 16:15
   *     Irstamacken
   *     Vallby vid entrén till Golfklubb.
   * Alla fyra gav ingenting alls: parseReportText kräver ett typord, och inget
   * av inläggen har ett. Fyra av de fem inlägg som föll i mätningen föll här.
   *
   * Priset för att öppna grinden är att "vad som helst" inte får bli polis. En
   * falsk nål lär föraren att strunta i appen, och den går inte att ta
   * tillbaka. Sju krav måste därför vara uppfyllda SAMTIDIGT — alla sju, och
   * det första bär huvudlasten. Tre av dem (3, 4 och 5) skrevs om 2026-08-22
   * efter en mätning som visade att de var för generösa; det står vid vart
   * och ett vad som mättes:
   *
   *   1. Texten måste PEKA UT ETT KÄNT PLATSNAMN (PLATSORD nedan). Det är den
   *      starkaste spärren och den enda som är POSITIV: ett ord vi aldrig sett
   *      kan aldrig bära ett inlägg. Jämför extractPlace, som är ett rent
   *      negativt filter och därför antar att varje okänt ord är ett platsnamn.
   *      Med det kravet blir "texten pekar ut en plats" mätbart i stället för
   *      en känsla.
   *   2. Inlägget måste vara KORT (högst PLATS_MAX_ORD ord). Konventionen är en
   *      lapp, inte ett resonemang.
   *   3. Texten får inte vara en FRÅGA. En fråga är motsatsen till ett
   *      påstående om vad någon just har sett. Frågetecknet räcker inte som
   *      spärr — det utelämnas ofta — så ett frågeord var som helst (FRAGEORD)
   *      och ett finit verb eller frågeord FÖRST i satsen (FRAGEINLEDNING)
   *      fäller inlägget var för sig.
   *   4. Texten måste vara en LAPP, inte en mening. Ett verb eller ett
   *      pronomen (VERB_OCH_PRONOMEN) diskvalificerar direkt: den som skriver
   *      "Jag åker till Erikslund nu" har skrivit en mening, och en mening kan
   *      handla om vad som helst.
   *   5. ALLT ÖVRIGT I TEXTEN måste peka på platsen. Utöver ortnamnet får bara
   *      bindeord och tidsord (PLATS_BINDEORD), avblåsningsord, riktningar,
   *      klockslag och ord som PRECISERAR platsen (PLATSPRECISERING) förekomma
   *      — entrén, macken, Hemköp. Ett enda okänt ord räcker för att avstå.
   *      Det är det som skiljer "Vallby vid entrén till Golfklubb" från "Bra
   *      pizza på Dillos igår" och från "Kö på E18 österut", där platsen bara
   *      är var något annat händer.
   *   6. Klockslag och färdriktning är inget krav men ett STÖD: de beskriver
   *      ett ögonblick och en rörelse, alltså precis vad en observation är, och
   *      ger ett mindre avdrag på tilliten (se parseReportText).
   *   7. Texten får inte innehålla ett typord ens som DELSTRÄNG. Kravet kom ur
   *      provsviten: utan det räddade platsregeln precis de meningar som
   *      typordsmatchningen medvetet vägrar. "Kameraövervakning i garaget på
   *      Vasagatan", "Parkeringskontrollen står på Vasagatan" och "Kontrollerna
   *      av matlådorna på skolan i Bäckby" blev alla polisvarningar, för de har
   *      ett känt ortnamn, är korta och innehåller inget annat ämnesord. Se
   *      motiveringen vid anropet.
   *
   * VALT BORT 1 — data/aliases.vasteras.json som lista. Den är rätt lista för
   * GEOKODNING och fel för det här beslutet. Dels går den inte att nå härifrån:
   * parser.js är synkron och fetch-fri, och bryggan kör på facebook.com där
   * filen inte finns. Dels innehåller den vanliga svenska ord i bestämd form —
   * punkt, gallerian, stationen, centralen, hamnen, arenan, sjukhuset,
   * lasarettet, flygplatsen, abb — och med dem hade "Ses vid stationen" blivit
   * en varning. PLATSORD är därför ett MEDVETET URVAL ur aliasfilen: bara namn
   * som inte betyder något annat på svenska. Grannkommunerna (Sala, Köping,
   * Arboga...) är också borta — konventionen gäller Västerås, och en ensam
   * kommunrubrik är oftare prat än en observation.
   *
   * VALT BORT 2 — att låta tilliten vara spärren. Platsbonusen i confidence är
   * `place.length >= 3` och säger ingenting om huruvida platsen ÄR en plats:
   * "Tack för tipset om polisen vid Erikslund" får 0,90 idag med platsfrasen
   * "tack för tipset". Tillit kan inte grinda det här.
   *
   * VALT BORT 3 — att kräva att INGENTING annat står i texten. Då hade bara
   * enordsinlägget "Irstamacken" räddats, medan "Hemköp Öster Mälarstrand" och
   * "Vallby vid entrén till Golfklubb" fallit. De är lika tydliga för en läsare.
   *
   * KVAR SOM RISK, MEDVETET: ett inlägg som bara är ett platsnamn kan gälla en
   * nykterhetskontroll där ordet står i bilden eller i kommentarerna. Texten
   * innehåller då ingenting för spärren att gå på — isSobrietyCheck kan bara
   * fånga ord som faktiskt är skrivna. Det är ett av skälen till att tolkningen
   * får LÄGRE tillit än ett uttalat påstående (se avdraget i parseReportText):
   * resten av systemet ska kunna behandla den försiktigare.
   */

  // Högst så många ord i inlägget. Konventionen är en lapp, inte ett
  // resonemang; "Idag firar gruppen 12 år med 18K följare" är fjorton ord.
  const PLATS_MAX_ORD = 8;

  /*
   * Namn som ensamma får bära ett inlägg. Urval ur data/aliases.vasteras.json
   * enligt VALT BORT 1 ovan: egennamn som inte också är ett gångbart svenskt
   * allmänord, och inga grannkommuner.
   *
   * Medvetet UTELÄMNADE härifrån trots att de står i aliasfilen: punkt,
   * gallerian, resecentrum, centralen, stationen, flygplatsen, hamnen, abb,
   * sjukhuset, lasarettet, mdh, mdu, arenan, 66an, 56an, rv66, rv56, sala,
   * köping, arboga, fagersta, hallstahammar, surahammar, kungsör, norberg,
   * skinnskatteberg, kvicksund.
   */
  const PLATSORD = [
    // Stadsdelar och orter i Västerås kommun
    'hälla', 'hälla köpcentrum', 'erikslund', 'erikslundsrondellen', 'rocklunda',
    'hammarby', 'hammarbyrampen', 'bäckby', 'backby', 'vallby', 'pettersberg',
    'råby', 'raby', 'bjurhovda', 'skiljebo', 'malmaberg', 'viksäng', 'viksang',
    'gideonsberg', 'skallberget', 'jakobsberg', 'blåsbo', 'emaus', 'nordanby',
    'önsta', 'gryta', 'hökåsen', 'hokasen', 'skultuna', 'irsta', 'barkarö',
    'tillberga', 'dingtuna', 'badelunda', 'tortuna', 'kungsåra', 'romfartuna',
    'lillhärad', 'gäddeholm', 'johannisberg', 'öster mälarstrand', 'lillåudden',
    // Namngivna hållpunkter. De sex sista skrev gruppen själv i de mätta
    // inläggen, och alla sex saknades i aliasfilen — inlägget kastades då med
    // "okänd-plats". Söksträngarna är tillagda där och provade mot Nominatim
    // 2026-08-22; ingen av dem är gissad.
    'dillos', 'dillos pizzeria', 'abb arena', 'bombardier',
    'apalby', 'apalby ip', 'irstamacken', 'emausskolan',
    'hemköp öster mälarstrand', 'vallby golfklubb', 'vallby golfklubben',
    'västerås golfklubb',
    // Gator och leder
    'stora gatan', 'vasagatan', 'kopparbergsvägen', 'björnövägen', 'bjornovagen',
    'djurgårdsvägen', 'norrleden', 'österleden', 'västerleden', 'bergslagsvägen',
    'köpingsvägen', 'surahammarsvägen', 'pilgatan', 'sigurdsgatan',
    'ängsgärdsgatan', 'e18', 'e18 västerut', 'e18 österut', 'riksväg 66',
    'riksväg 56', 'räta linjen',
  ];
  const PLATSORD_SET = new Set(PLATSORD);
  const PLATS_MAX_LED = Math.max(...PLATSORD.map(p => p.split(' ').length));

  /*
   * Efterled i sammansatta platsnamn där ORTNAMNET STÅR FÖRST: "Irstamacken" är
   * macken i Irsta, "Vallbyrondellen" rondellen i Vallby.
   *
   * Det är motsatt riktning mot typordsmatchningen (matchaOrd), som bygger på
   * att svenska sammansättningar är huvudfinala. Här är huvudordet just det som
   * INTE är platsen, så matchningen måste gå framifrån — och en prefixmatchning
   * utan en sluten lista över efterled hade gjort varje ord som råkar börja på
   * ett ortnamn till en plats. Listan är därför sluten och kort.
   */
  const ORTSLED = new Set([
    'macken', 'mackarna', 'rondellen', 'rondell', 'krysset', 'korset', 'korsningen',
    'torget', 'torg', 'skolan', 'centrum', 'badet', 'hallen', 'kyrkan', 'bron',
    'backen', 'motet', 'avfarten', 'påfarten', 'infarten', 'vägen', 'gatan',
    'gården', 'parken', 'viken', 'udden', 'ip',
  ]);
  // Kortare förled än så vore gissningar: "råby" i "råbygga" är inte Råby.
  const ORTSLED_MINLANGD = 5;

  /*
   * Ord som gör inlägget till en fråga. En fråga är motsatsen till ett
   * påstående om vad någon just har sett, och NOISE_PHRASES fångar bara de
   * exakta frasvändningar som mätts.
   *
   * MÄTT 2026-08-22: listan var för smal och de saknade orden stod dessutom i
   * STOPWORDS, alltså räknades de AKTIVT som ord som pekar på platsen. "Är
   * någon vid Vallby nu", "Var det vid Vasagatan" och "Nån som är i Irsta nu"
   * blev alla report/police 0,70 och hamnade som nålar på kartan. Felet är
   * självförstärkande: den som frågar gör det ofta för att appen redan visat
   * en nål där, och svaret blev en ny nål på samma plats.
   */
  const FRAGEORD = new Set(['vem', 'vad', 'vart', 'varför', 'hur', 'vilken', 'vilket',
    'vilka', 'undrar', 'vet', 'stämmer', 'kanske', 'finns', 'nån', 'någon', 'frågar']);

  /*
   * Ord som gör inlägget till en fråga NÄR DE STÅR FÖRST.
   *
   * Frågetecknet räcker inte: det utelämnas ofta i en snabb mobilkommentar,
   * och FRAGEORD kan bara ta de ord som aldrig betyder något annat. En svensk
   * sats som INLEDS med ett finit verb är däremot nästan alltid en fråga —
   * "Är någon vid Vallby", "Har dom åkt", "Ser ni polisen" — medan ett
   * påstående inleds med satsdelen som bär informationen. Konventionens egna
   * inlägg inleds undantagslöst med platsnamnet.
   *
   * Orden prövas FÖRE stopporden med flit. Flera av dem (var, är, har, ser)
   * står i STOPWORDS, och den listan är byggd för platsUTTAG — där är ett
   * verb bara skräp att stryka, här är det beviset på att någon skrev en
   * mening.
   */
  const FRAGEINLEDNING = new Set(['var', 'är', 'ar', 'har', 'hade', 'ser', 'såg', 'finns',
    'kan', 'ska', 'vill', 'vet', 'undrar', 'gör', 'blir', 'kommer', 'får', 'tror', 'verkar',
    'nån', 'någon', 'vem', 'vad', 'vart', 'varför', 'hur', 'vilken', 'vilket', 'vilka',
    'stämmer', 'minns']);

  /*
   * Verb och pronomen. Ett enda av dem gör att texten inte längre är en LAPP.
   *
   * Konventionen "platsen ensam betyder polis" gäller lappar: någon skriver
   * var hen ser polisen och inget mer. Den som skriver ett verb har skrivit
   * en mening, och en mening kan handla om vad som helst — "Jag åker till
   * Erikslund nu", "Vi kommer från Skultuna", "Sitter på Max i Erikslund".
   *
   * MÄTT 2026-08-22, och det är därför listan finns: krav 5 nedan använde
   * STOPWORDS som godkännandelista. Den listan är byggd för det MOTSATTA
   * ändamålet — att stryka ord ur en fras som redan har ett typord — och
   * innehåller därför jag, vi, man, är, kommer, kör, ser, kolla. Vänd om till
   * en positiv grind blev varje vardaglig mening med ett ortnamn i en
   * polisvarning: 13 av 30 provade vardagsmeningar gav report/police 0,70,
   * alla med en aliasnyckel som geokodar rent — alltså riktiga nålar.
   *
   * Listan är sluten och diskvalificerar direkt. Den kostar ingenting av de
   * fyra mätta måltexterna: ingen av dem innehåller vare sig verb eller
   * pronomen. Avblåsningsorden (CLEAR_WORDS: åkte, borta, fritt) står
   * medvetet INTE här — de är hela poängen med att "Rocklunda fritt nu" ska
   * kunna bli en släckning i stället för en varning.
   */
  const VERB_OCH_PRONOMEN = new Set([
    'jag', 'du', 'vi', 'ni', 'man', 'dom', 'de', 'den', 'mig', 'dig', 'oss', 'er', 'dem',
    'är', 'ar', 'var', 'vara', 'har', 'hade', 'kommer', 'kom', 'kör', 'körde', 'åker',
    'sitter', 'satt', 'ligger', 'låg', 'står', 'stod', 'ser', 'såg', 'sett', 'kolla',
    'kollade', 'ses', 'ska', 'skulle', 'vill', 'tänker', 'tror', 'undrar', 'vet', 'gör',
    'blir', 'jobbar', 'bor', 'går', 'gick', 'tar', 'fick', 'får',
  ]);

  /*
   * Ord som PRECISERAR platsen: byggnaden, macken, entrén, kedjan på skylten.
   *
   * De är det enda innehåll utöver själva ortnamnet som ett inlägg får bära.
   * Listan är POSITIV med flit, och den är den andra halvan av krav 5. En
   * negativ ämneslista prövades först ('kö', 'olycka', 'vägarbete'...) och den
   * mätte fel: den släppte igenom "Bra pizza på Dillos igår", "Hej alla i
   * Skultuna" och — värst av allt — "Irsta sållning", eftersom inget av de
   * orden stod på listan. Ett negativt filter kan bara vägra det någon redan
   * tänkt på, och det är precis den svagheten som gör extractPlace opålitlig.
   *
   * Med den positiva vändningen gäller i stället: ALLT i texten måste peka på
   * platsen. Ett enda ord vi inte känner igen räcker för att avstå. Regeln
   * felar därmed åt rätt håll — den tappar tolkningar, den hittar aldrig på
   * dem — och listan växer när nya inlägg mätts, inte när nya risker gissats.
   */
  const PLATSPRECISERING = new Set([
    // Delar av en plats
    'entré', 'entrén', 'entren', 'ingången', 'ingång', 'utgången', 'utfarten',
    'parkeringen', 'parkering', 'parkeringsplatsen', 'hållplatsen', 'busshållplatsen',
    'viadukten', 'tunneln', 'gångbron', 'övergångsstället', 'refugen',
    // Anläggningar
    'macken', 'mack', 'bensinmacken', 'laddstationen', 'golfklubb', 'golfklubben',
    'golfbanan', 'skolan', 'förskolan', 'gymnasiet', 'kyrkan', 'badet', 'simhallen',
    'ishallen', 'sporthallen', 'idrottsplatsen', 'torget', 'köpcentret', 'köpcentrum',
    'centrum', 'gallerian', 'affären', 'butiken', 'restaurangen', 'pizzerian',
    'kiosken', 'vårdcentralen', 'industriområdet', 'återvinningen', 'ip',
    // Skyltarna folk går efter
    'hemköp', 'ica', 'coop', 'willys', 'lidl', 'netto', 'maxi', 'city', 'gross',
    'preem', 'circle', 'shell', 'okq8', 'ingo', 'st1', 'tanka', 'biltema', 'jula',
    'systembolaget', 'mcdonalds', 'burger', 'king', 'sibylla', 'max',
  ]);

  /*
   * Färdriktningar som gruppen skriver ut. DIRECTION_HINTS ovan har bara
   * -ut-formerna; konventionen i den här gruppen är -gående. Orden räknas som
   * STÖD för tolkningen (de beskriver en observation i rörelse) och aldrig som
   * ett okänt innehållsord.
   */
  const FARDRIKTNING = new Set(['norrgående', 'södergående', 'östergående', 'västergående',
    'norrgaende', 'sodergaende', 'ostergaende', 'vastergaende']);

  /*
   * Småord som binder ihop en plats med sin precisering, plus tidsorden.
   *
   * Listan är EGEN och kort med flit, och det är hela skillnaden mot den
   * version som mättes 2026-08-22. Då lydde krav 5 "STOPWORDS eller
   * KLAUSULORD eller PLATS_SMAORD", alltså tre listor byggda för andra
   * ändamål, och summan av dem godkände i praktiken vilken vardaglig mening
   * som helst (se VERB_OCH_PRONOMEN). En godkännandelista måste skrivas för
   * att vara godkännandelista: varje ord här ska gå att läsa som "det här
   * ordet pekar på platsen", ingenting annat.
   *
   * Vad som medvetet INTE står här:
   *   - Verb och pronomen. De diskvalificerar i stället, se VERB_OCH_PRONOMEN.
   *   - Bisatsorden (KLAUSULORD: om, när, som, men). Efter dem beskriver
   *     meningen något ANNAT än var polisen står — det är själva skälet till
   *     att extractPlace bryter på dem — och en lapp har ingen bisats.
   *   - Satsglue: så, att, än, här, där, eller. Samma sak: de bygger meningar.
   */
  const PLATS_BINDEORD = new Set([
    // Var i förhållande till platsen
    'vid', 'på', 'i', 'utanför', 'innanför', 'mot', 'runt', 'kring', 'nere', 'uppe',
    'bakom', 'framför', 'bredvid', 'mellan', 'över', 'under', 'efter', 'före',
    'ner', 'upp', 'in', 'ut', 'till', 'från',
    // Bindeord mellan två platsled
    'och', 'samt', 'plus', 'med',
    // Tiden. Klockslagen är nakna tal efter normalize(); orden står här.
    'nu', 'just', 'precis', 'idag', 'ikväll', 'inatt', 'imorgon', 'kl', 'klockan',
    'fortfarande', 'kvar', 'hela',
  ]);

  // Klockslag i RÅtexten. normalize() byter ':' och '.' mot blanksteg, så
  // tidsangivelsen är redan sönderdelad när parsern ser den.
  const TID_RE = /\d{1,2}[.:]\d{2}/;

  // Bindestreck överlever normalize(). "Mälarstrand-" måste matcha nyckeln
  // "mälarstrand", annars faller "Hemköp Öster Mälarstrand- 16:15" på ett
  // skiljetecken.
  const utanBindestreck = w => w.replace(/^-+|-+$/g, '');

  /**
   * Hittar det längsta kända platsnamnet i ordföljden.
   * @returns {null | {namn: string, i: number, n: number}} namn = aliasnyckeln,
   *          i = första ordets index, n = antal ord platsen tar upp.
   */
  function hittaKandPlats(words) {
    const rena = words.map(utanBindestreck);
    // Längst först: "öster mälarstrand" ska vinna över ett ensamt led.
    for (let n = Math.min(PLATS_MAX_LED, rena.length); n >= 1; n--) {
      for (let i = 0; i + n <= rena.length; i++) {
        const fras = rena.slice(i, i + n).join(' ');
        if (PLATSORD_SET.has(fras)) return { namn: fras, i, n };
      }
    }
    /*
     * Sammansättningen prövas SIST och bara när inget helt namn hittats.
     * Namnet som returneras är BASEN, inte hela ordet: "vallbyrondellen" finns
     * inte i aliasfilen, men "vallby" gör det. Nålen hamnar då i stadsdelen i
     * stället för vid rondellen — några hundra meter fel, och ändå oändligt
     * mycket bättre än ingen nål alls.
     *
     * "Irstamacken" var exemplet här tills macken slogs upp och lades in i
     * data/aliases.vasteras.json med en provad söksträng ("Circle K, Irsta").
     * Den vägen är alltid bättre: ett inlagt namn ger rätt koordinat, medan
     * basen bara ger rätt trakt. Faller ett efterled ofta i loggen är svaret
     * att lägga in platsen, inte att bredda den här listan.
     */
    for (let i = 0; i < rena.length; i++) {
      const w = rena[i];
      for (const namn of PLATSORD) {
        if (namn.includes(' ') || namn.length < ORTSLED_MINLANGD) continue;
        if (w.length <= namn.length || !w.startsWith(namn)) continue;
        const efterled = w.slice(namn.length).replace(/^s/, '');   // foge-s
        if (ORTSLED.has(efterled)) return { namn, i, n: 1 };
      }
    }
    return null;
  }

  /**
   * Gruppens konvention som en syntetisk typordsträff, eller null.
   *
   * Formen är med flit densamma som findType returnerar, så att allt nedanför
   * kroken i parseReportText kan köras oförändrat. Två fält är nya:
   *   plats — aliasnyckeln som matchade. Måste användas i stället för
   *           extractPlace, se motiveringen vid anropet.
   *   stod  — texten bär också ett klockslag eller en färdriktning. Det gör
   *           tolkningen säkrare (någon rapporterar ett ögonblick), och
   *           avdraget på tilliten blir mindre.
   */
  function platsEnsamSomTyp(raw, text, words) {
    if (words.length > PLATS_MAX_ORD) return null;
    if (String(raw).includes('?')) return null;

    // Frågeorden prövas FÖRE allt annat, och första ordet prövas mot en egen
    // lista: en sats som inleds med ett finit verb eller ett frågeord är på
    // svenska nästan alltid en fråga, med eller utan frågetecken. Se
    // FRAGEINLEDNING — alla tre mätta fallen saknade frågetecken.
    if (FRAGEINLEDNING.has(utanBindestreck(words[0]))) return null;
    for (const w of words) {
      if (FRAGEORD.has(utanBindestreck(w))) return null;
    }

    /*
     * ETT VERB ELLER ETT PRONOMEN BETYDER ATT NÅGON SKREV EN MENING, och
     * konventionen gäller lappar. Kontrollen står här uppe, före både
     * platsuppslaget och krav 5, av två skäl: den är den billigaste av alla
     * (en mängduppslagning per ord), och den ska gälla ORD FÖR ORD i hela
     * texten — även de ord som något annat filter längre ner råkar godkänna.
     */
    for (const w of words) {
      if (VERB_OCH_PRONOMEN.has(utanBindestreck(w))) return null;
    }

    /*
     * Delsträng, inte matchaOrd — och riktningen är hela poängen.
     *
     * Vi står här bara därför att findType redan sagt nej. Står ett typord ändå
     * i texten betyder det att matchningen AKTIVT valde bort ordet:
     * "kameraövervakning" och "polisanmälan" har listordet först och betyder
     * något annat, "kontrollerna" och "parkeringskontrollen" stoppas av
     * INGEN_SAMMANSATTNING. Alla tre försvann tyst av goda skäl, och
     * konventionsargumentet gäller inte dem: en text som faktiskt handlar om en
     * kontroll av matlådor blir inte en polisobservation av att den nämner
     * Bäckby. Hade skribenten menat polis hade hen skrivit ett ord vi tar emot.
     *
     * Delsträngen är trubbig med flit. Den felar bara åt ett håll — färre
     * platstolkningar, aldrig fler — och en fras som "matkasse" (som råkar bära
     * 'atk') kostar oss en tolkning vi ändå bara gissade oss till.
     */
    if (ALLA_TYPORD.some(w => text.includes(w))) return null;

    const traff = hittaKandPlats(words);
    if (!traff) return null;

    /*
     * ALLT ÖVRIGT I TEXTEN MÅSTE PEKA PÅ PLATSEN. Ett enda ord vi inte känner
     * igen räcker för att avstå — inte "högst två", som en tidigare version
     * tillät. Taket mättes och var för generöst: "Bra pizza på Dillos igår",
     * "Hej alla i Skultuna" och "Irsta sållning" hade alla högst två okända ord
     * och blev polisvarningar. Det sista är det allvarliga: 'sållning' ensamt
     * står inte i nykterhetsspärrens ordlistor, och regeln hade då gjort en
     * nykterhetskontroll till en publicerad polisnål. Nollkravet stänger det
     * hålet utan att röra säkerhetsfiltret.
     *
     * Godtagbart är: stoppord och bisatsord, avblåsningsord (så att "Rocklunda
     * fritt nu" kan bli en AVBLÅSNING i stället för att tystna), riktningar,
     * bindeord, klockslag — och ord som preciserar platsen.
     *
     * NOT_A_PLACE i sin helhet duger INTE som godkännandelista, trots att den
     * ligger nära till hands: den innehåller hälsningsord och bilfärger, och
     * med dem hade "Hej Skultuna" blivit en varning.
     *
     * STOPWORDS duger inte heller, och det var det MÄTTA felet 2026-08-22:
     * den listan är byggd för platsuttaget, där ett extra ord bara kortar
     * frasen. Som godkännandelista släppte den igenom pronomen och verb och
     * gjorde 13 av 30 vardagsmeningar till polisvarningar. Se PLATS_BINDEORD.
     */
    for (let i = 0; i < words.length; i++) {
      if (i >= traff.i && i < traff.i + traff.n) continue;   // platsen själv
      const w = utanBindestreck(words[i]);
      if (!w) continue;
      if (PLATS_BINDEORD.has(w)) continue;
      if (CLEAR_WORDS.includes(w)) continue;
      if (DIRECTION_HINTS.has(w) || FARDRIKTNING.has(w)) continue;
      if (PLATSPRECISERING.has(w)) continue;
      // Klockslagen är nakna tal efter normalize(), se TID_RE.
      if (/^\d+$/.test(w)) continue;
      return null;
    }

    const stod = TID_RE.test(String(raw)) || words.includes('kl') || words.includes('klockan') ||
                 words.some(w => FARDRIKTNING.has(w) || DIRECTION_HINTS.has(w));

    // Typen blir 'police': det är vad konventionen betyder. Inte 'control' —
    // inlägget säger inte att det är en hastighetsmätning, bara att polisen
    // står där.
    return { type: 'police', word: null, traff: 'plats', gi: 99, idx: -1, plats: traff.namn, stod };
  }

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

    // Isärskrivet: förled + huvudord som två ord bredvid varandra. Båda leden
    // får nu vara böjda ("nykterhets kontrollen", "drog testet"). Förr krävdes
    // exakt likhet i båda leden, och då räckte ett -en för att gå förbi hela
    // spärren.
    for (let i = 0; i < words.length - 1; i++) {
      const forled = SOBRIETY_PREFIX.some(f => arBojningAv(words[i], f));
      if (forled && SOBRIETY_HEAD.some(h => arBojningAv(words[i + 1], h))) return true;
    }

    /*
     * Hopskrivet: förled + huvudord i ETT ord, där huvudordet är böjt.
     * "drogkollen" gick igenom allt annat — 'drog' är inget stamord (det är
     * också imperfekt av "dra"), 'drogkoll' står inte i ordlistan, och regeln
     * ovan letar efter två ord. Här delas ordet vid förledet i stället och
     * resten prövas som huvudord. Foge-s stryks.
     */
    for (const w of words) {
      for (const f of SOBRIETY_PREFIX) {
        if (w.length <= f.length || !w.startsWith(f)) continue;
        const rest = w.slice(f.length).replace(/^s/, '');
        if (SOBRIETY_HEAD.some(h => arBojningAv(rest, h))) return true;
      }
    }
    return false;
  }

  const TRAFF_RANG = { exakt: 3, bojning: 2, sammansatt: 1 };

  /*
   * Hittar det BÄSTA typordet, inte det första. Förr vann första träffen i
   * gruppordning; med sammansättningar är det farligt, eftersom kameragruppen
   * står först och en kameraträff vägras. Ordningen är träffkvalitet först,
   * sedan gruppordningen, sedan listordets längd. Gruppordningen står före
   * längden med flit: den är ett produktbeslut, och med den ordningen svarar
   * parsern exakt som förut på inlägg där alla träffar är exakta.
   */
  function findType(text, words) {
    let basta = null;
    for (let gi = 0; gi < TYPE_WORDS.length; gi++) {
      const group = TYPE_WORDS[gi];
      for (const w of group.words) {
        let traff = null;
        // Var i meningen ordet stod. Kameraregeln behöver det för att kunna
        // fråga vad som står BREDVID kameraordet i stället för var som helst.
        let idx = -1;
        if (w.includes(' ')) {
          // Flerordsfraser matchas mot hela texten som förut: de är två ord,
          // och en ändelsematchning per ord behöver veta vilket som är huvudet.
          // De finns bara i unmarked-gruppen, alltså aldrig i kameraregeln,
          // och saknar därför ordindex utan att något går förlorat.
          if (text.includes(w)) traff = 'exakt';
        } else {
          for (let oi = 0; oi < words.length; oi++) {
            const m = matchaOrd(words[oi], w);
            if (m && (!traff || TRAFF_RANG[m] > TRAFF_RANG[traff])) { traff = m; idx = oi; }
          }
        }
        if (!traff) continue;
        const kandidat = { type: group.type, word: w, traff, gi, idx };
        if (!basta || arBattreTraff(kandidat, basta)) basta = kandidat;
      }
    }
    return basta;
  }

  function arBattreTraff(a, b) {
    if (TRAFF_RANG[a.traff] !== TRAFF_RANG[b.traff]) return TRAFF_RANG[a.traff] > TRAFF_RANG[b.traff];
    if (a.gi !== b.gi) return a.gi < b.gi;
    return a.word.length > b.word.length;
  }

  const hasAnyWord = (words, list) => list.some(w => words.includes(w));
  const hasAnyPhrase = (text, list) => list.some(p => text.includes(p));

  const ALLA_TYPORD = [...new Set(TYPE_WORDS.flatMap(g => g.words.flatMap(w => w.split(' '))))];

  // SAMMA matchning som findType, och det är avgörande: vore rensningen kvar
  // på exakt likhet blev "trafikkamera" både typ och plats. Hela ordet
  // plockas bort, inte bara ändelsen — ingen "trafik" blir kvar.
  const arTypord = ord => ALLA_TYPORD.some(w => matchaOrd(ord, w) !== null);

  /*
   * Svaga platsled: ord som säger VAR VID platsen något står, inte VILKEN
   * plats det är. De står här och inte bland stopporden, för ett stoppord
   * försvinner helt. Ett svagt platsled sparas undan och används när
   * ingenting annat blev kvar: "Rondellen norrut" och "Polis mot stan" är
   * sämre platser än ett ortnamn men oändligt mycket bättre än tom sträng,
   * för utan plats faller rapporten på tröskeln 0,65.
   */
  const SVAGA_PLATSLED = new Set([
    ...DIRECTION_HINTS, ...FARDRIKTNING,
    'stan', 'entrén', 'entren', 'entré', 'entre', 'parkeringen', 'parkering',
  ]);

  /*
   * Vilka ord är ett klockslag?
   *
   * normalize() byter ':' och '.' mot blanksteg INNAN parsern ser texten, så
   * "13.45" är två ord — "13" och "45" — när rensningen når dem. Regeln som
   * stod här förut, /^\d{1,2}[:.]\d{2}$/, kunde därför aldrig träffa något:
   * den letade efter ett tecken som redan var borta.
   *
   * Paret måste vara ett GILTIGT klockslag, inte vilka två tal som helst.
   * Annars försvinner vägnumret ur "riksväg 66 11.15": 66 följt av 11 ser ut
   * som ett par, och timmen 66 finns inte. Ett ENSAMT tal rörs inte —
   * "Vasagatan 12" är ett husnummer och hjälper geokodningen.
   */
  function klockslagsindex(words) {
    const arKlockslag = new Array(words.length).fill(false);
    for (let i = 0; i < words.length - 1; i++) {
      if (!/^\d{1,2}$/.test(words[i]) || Number(words[i]) > 23) continue;
      if (!/^\d{2}$/.test(words[i + 1]) || Number(words[i + 1]) > 59) continue;
      arKlockslag[i] = true;
      arKlockslag[i + 1] = true;
      i++;
    }
    return arKlockslag;
  }

  /*
   * Vägorden (rondellen, avfarten, rampen) räknas inte som plats — det stod
   * redan i kommentaren vid DIRECTION_HINTS, men rensningen gjorde det inte
   * förrän nu. De sparas ändå undan: är de allt vi har är "rondellen norrut"
   * bättre än ingen plats, för utan plats faller rapporten på tröskeln.
   *
   * SIST PRÖVAS DELFRASERNA MOT DE KÄNDA NAMNEN, och det är den delen som
   * löser de mätta bortfallen. Rensningen är ett NEGATIVT filter: den kan
   * bara ta bort ord den känner igen och antar att allt annat är ett
   * platsnamn. "Laser vid Hammarby- korsningen vid la pizza" blir därför
   * "hammarby la pizza", och ingen ordlista kommer att innehålla "la pizza".
   * hittaKandPlats vänder på frågan och letar POSITIVT efter det längsta
   * kända namnet någonstans i frasen, så delfrasen "hammarby" vinner.
   *
   * Det väger extra tungt HÄR: bryggans geokodare gör ETT Nominatim-anrop med
   * hela frasen, utan aliaslista och utan att korta den. Appen har en
   * prefixkortning som ibland räddar en skräpig fras; bryggan har ingenting.
   *
   * Priset, uttalat: hittas ett känt namn kastas resten av frasen. "Polis på
   * Vasagatan 12" geokodas som "vasagatan" och nålen hamnar på gatan i
   * stället för vid huset — ett känt namn har en provad söksträng, ett
   * husnummer har ingen.
   */
  function extractPlace(words) {
    const kept = [];
    const medVagord = [];
    const arKlockslag = klockslagsindex(words);
    for (let i = 0; i < words.length; i++) {
      // Bindestrecket överlever normalize() för gatunamnens skull, men i
      // kanten av ett ord är det skiljetecken: "Hammarby-" är Hammarby.
      const w = utanBindestreck(words[i]);
      if (!w) continue;
      if (KLAUSULORD.has(w)) {
        /*
         * Bryt bara när vi har ett RIKTIGT platsled, alltså kept och inte
         * medVagord. Gränsen bröt först på medVagord, och då räckte ett enda
         * fyllnadsord före bisatsordet för att kasta resten av meningen:
         * "Poliskontroll idag som ligger vid Hälla" gav platsen "idag", som
         * ingen geokodning hittar. Vägorden (rondellen, avfarten) är inget
         * att gå på: "Snutarna vid rondellen som står vid Hälla" ska ge
         * "hälla".
         */
        if (kept.length) break;        // bisatsen beskriver inte platsen
        continue;                      // ...inleder den meningen är den bara ett stoppord
      }
      if (arTypord(w)) continue;
      if (STOPWORDS.has(w)) continue;
      if (NOT_A_PLACE.has(w)) continue;
      if (arKlockslag[i]) continue;                    // klockslag, se ovan
      if (/^\d+$/.test(w) && w.length > 3) continue;   // långa sifferklumpar
      medVagord.push(w);
      if (SVAGA_PLATSLED.has(w)) continue;
      kept.push(w);
    }
    const ord = kept.length ? kept : medVagord;
    // Samma uppslag som platsregeln använder, med flit: två listor över kända
    // platser i samma fil hade drivit isär, och den som glömdes bort hade
    // blivit ett tyst bortfall igen.
    const kand = hittaKandPlats(ord);
    return (kand ? kand.namn : ord.join(' ')).trim();
  }

  /*
   * @param {{platsKonvention?: boolean}} [val]
   *   platsKonvention — får ett kort inlägg som bara pekar ut ett känt
   *   platsnamn läsas som "polis här"? Se PLATSORD.
   *
   *   FLAGGAN ÄR AV SOM STANDARD, OCH DET ÄR HELA POÄNGEN. Regeln är en
   *   GRUPPREGEL: "Här Står Polisen - Västerås" har på sin om-sida att man
   *   skriver enbart när man ser en poliskontroll. Ingen sådan konvention
   *   finns för rösten eller appens egna fält, och js/parser.js är samma
   *   funktion där. Bryggan läser bara gruppen och sätter därför flaggan vid
   *   anropet i skanningen — inte här.
   */
  function parseReportText(raw, val = {}) {
    const { platsKonvention = false } = val;
    const text = normalize(raw);
    if (!text || text.length < 3) return null;

    if (isSobrietyCheck(text)) return { intent: 'refused', reason: 'sobriety' };

    const words = text.split(' ');
    let t = findType(text, words);

    /*
     * PLATSEN ENSAM ÄR EN VARNING. Inget typord — men gruppens konvention är
     * att man skriver ENBART när man ser polis, så ett kort inlägg som pekar
     * ut en känd plats betyder polis där. Se motiveringen vid PLATSORD.
     *
     * Kroken sitter PÅ DEN HÄR RADEN med flit, inte som ett eget tidigt
     * return längre upp. Placeringen är hela skillnaden mellan rätt och fel
     * svar:
     *   - Nykterhetsspärren ovan har redan kört, och kör alltså också för den
     *     här vägen. Säkerhetsregeln kan inte kringgås av en platsregel.
     *   - Brusfiltren, gruppmetafiltret, avblåsningsraden, platsuttaget och
     *     tilliten nedanför körs oförändrat. Det är därför "Rocklunda fritt
     *     nu" blir en AVBLÅSNING och inte en varning: raden med CLEAR_WORDS
     *     nås. Ett tidigt return hade lagt en polisnål på en plats som nyss
     *     blivit fri — den naturliga första implementationen, och den farliga.
     *   - Kamerablocket nedanför frågar bara efter type === 'camera' och rör
     *     alltså inte den syntetiska träffen.
     *   - Raden nås bara när dagens kod redan svarar null, så inget befintligt
     *     fall kan byta svar.
     *
     * Flaggan gör regeln till det den är: en GRUPPREGEL. Rösten och appens
     * egna fält har ingen sådan konvention, och där är ett ensamt platsnamn
     * oftast en avhuggen mening. Se motiveringen vid parametern.
     */
    if (!t && platsKonvention) t = platsEnsamSomTyp(raw, text, words);
    if (!t) return null;

    /*
     * FASTA fartkameror står still, finns redan i appen med rätt koordinat
     * och mätriktning, och en handmarkerad kamera hamnar nästan alltid fel.
     *
     * MOBILA kameror är motsatsen på varje punkt: de står där i några timmar,
     * de finns inte i någon kartdata, och den enda som kan berätta att de
     * står där är någon som just körde förbi. Driftfallet 2026-08-22 var just
     * en mobil kamera, som först försvann i ordmatchningen och sedan hade
     * fastnat här.
     *
     * Typen blir 'control', inte 'camera'. 'camera' betyder något bestämt i
     * resten av appen — TTL ett år, notiser avstängda för användarkällor,
     * behandlas som fast anläggning — och en mobil kamera med den typen hade
     * blivit en tyst nål som ligger kvar i ett år. 'control' betyder
     * "tillfällig hastighetsmätning här och nu": 60 minuter, notis på. Det är
     * vad en mobil kamera ÄR. Fältet kamera:'mobil' bär ursprunget vidare.
     */
    /*
     * Mobilordet måste höra ihop med kameraordet, inte bara finnas i texten.
     * Se motiveringen vid MOBIL_KAMERA_ORD: "jag har bilden i min mobil" är
     * ingen mobil kamera. Två undantag från grannkravet, båda åt rätt håll:
     * ett listord som SJÄLVT betyder flyttbar kamera (kamerasläp, kameravagn)
     * behöver inget grannord, och ett "fast" intill kameraordet vinner alltid
     * över ett mobilord i samma fönster.
     */
    const mobilKamera = t.type === 'camera' &&
      !narOrdet(words, t.idx, FAST_KAMERA_ORD) &&
      (MOBILA_TYPORD.has(t.word) || narOrdet(words, t.idx, MOBIL_KAMERA_ORD));
    if (t.type === 'camera' && !mobilKamera) return { intent: 'refused', reason: 'camera' };
    const type = mobilKamera ? 'control' : t.type;

    if (hasAnyPhrase(text, NOISE_PHRASES)) return null;
    if (hasAnyWord(words, NOISE_WORDS) && words.length < 5) return null;
    // Gruppens eget prat, oavsett längd. Se GRUPPMETA_ORD: gruppnamnet
    // innehåller ett typord, så varje metainlägg får en typordsträff gratis.
    if (hasAnyWord(words, GRUPPMETA_ORD)) return null;

    const intent = hasAnyWord(words, CLEAR_WORDS) ? 'clear' : 'report';
    /*
     * Platsen kommer från platsregeln när det var den som bar inlägget.
     * extractPlace duger inte där: utan typord rensar arTypord ingenting, och
     * "Vallby vid entrén till Golfklubb" hade gett platsfrasen "vallby entrén
     * till golfklubb" — hela skräpfras-problemet ärvt rakt in i den nya vägen.
     * Aliasnyckeln är dessutom det enda som säkert går att geokoda.
     */
    const place = t.plats !== undefined ? t.plats : extractPlace(words);

    let confidence = 0.5;
    if (place.length >= 3) confidence += 0.3;
    if (words.length <= 8) confidence += 0.1;
    else if (words.length > 25) confidence -= 0.2;
    if (type === 'control') confidence += 0.05;
    if (words.some(w => DIRECTION_HINTS.has(w))) confidence += 0.05;

    // En osäkrare matchning ska ge en osäkrare rapport. Avdraget är litet med
    // flit: det ska rangordna rapporter mot varandra, inte ensamt fälla dem
    // under tröskeln 0,65.
    /*
     * Platsregeln är en TOLKNING AV EN KONVENTION, inte av ett uttalat
     * påstående. Ingen har skrivit "polis" — vi läser in det ur att någon
     * över huvud taget skrev i gruppen. Avdraget är därför det största av
     * alla, och ordningen på grenarna gör platsträffen till lägsta klassen:
     *   "Polis vid Vallby"                  0,90   exakt typord
     *   "Trafikpolisen vid Vallby"          0,80   sammansatt typord
     *   "Dillos norrgående 11.15"           0,75   plats + klockslag/riktning
     *   "Vallby vid entrén till Golfklubb"  0,70   plats ensam
     * Nivåerna når fortfarande över tröskeln 0,65 (CONFIG.minConfidence) —
     * under den kastas inlägget och regeln vore död — men ligger tydligt
     * under varje rapport med ett utskrivet typord.
     */
    if (t.traff === 'plats') confidence -= (t.stod ? 0.15 : 0.2);
    else if (t.traff === 'sammansatt') confidence -= 0.1;
    else if (t.traff === 'bojning') confidence -= 0.05;

    const svar = {
      intent,
      type,
      place,
      confidence: Math.max(0, Math.min(1, confidence)),
      raw: String(raw).trim(),
      traff: t.traff,
    };
    if (mobilKamera) svar.kamera = 'mobil';
    return svar;
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

  /*
   * NYCKLARNA BÄR GRUPPEN — men inte båda på samma sätt, och skillnaden är
   * mätt snarare än smaksak.
   *
   * stable är bryggans EGNA nycklar: hanteringslistan och först-sedd. Där
   * måste gruppen med. "Polis vid Storgatan" i Stockholmsgruppen och samma
   * mening i Västeråsgruppen är två olika händelser, och utan gruppen i
   * nyckeln hade den andra räknats som redan hanterad och tystnat.
   *
   * externalId är databasens dedupnyckel, och där skiljer sig de två fallen:
   *
   *   • Med inläggs-id: fb:<inläggets id>. Facebooks inläggs-id är globalt
   *     unikt — samma id kan inte förekomma i två grupper. Att klistra på
   *     gruppen hade inte tagit bort någon kollision, men det hade gett
   *     varenda redan skickad rapport en ny nyckel vid uppgraderingen, och
   *     då dyker de upp EN GÅNG TILL på kartan för de förare som kör just nu.
   *     Formen är därför oförändrad med flit.
   *
   *   • Utan inläggs-id: fb:<grupp>:<texthash>:<tidsfack>. Här är kollisionen
   *     verklig. Hashen räknas på texten och ingenting annat, så "Polis vid
   *     Storgatan" ger samma hash i alla grupper — utan gruppen i nyckeln
   *     hade den andra gruppens varning tystats som en dubblett av den
   *     första, fast den gällde en annan stad.
   */
  /*
   * Nyckeln får inte bero på om Facebook hunnit rendera färdigt.
   *
   * story_message består av två blockelement. Innan layouten är klar ger
   * innerText ingen radbrytning mellan dem, och orden växer ihop:
   *
   *   färdigrenderat:  "...sträckan\nBörjar nu"  ->  "...sträckan börjar nu"
   *   halvrenderat:    "...sträckanBörjar nu"    ->  "...sträckanbörjar nu"
   *
   * Whitespace-normalisering räddar inte det — det finns inget blanksteg
   * att kollapsa, det saknas helt. Två hashar för samma inlägg betyder två
   * saker, och båda är dåliga: samma varning kan skickas två gånger, och
   * värre, ett gammalt inlägg som råkar renderas om får en ny nyckel,
   * registreras som osett och ser därmed nyfött ut. En dygnsgammal
   * laservarning som ploppar upp som färsk är precis det fel som får en
   * förare att sluta lita på appen.
   *
   * Därför tas ALLA blanksteg bort innan hashning. Två inlägg som skiljer
   * sig enbart på mellanslag räknas då som samma, vilket är rätt: de är
   * samma text för en läsare.
   */
  const texthash = t => hash(normalize(t).replace(/\s+/g, ''));

  function keysFor(post, grupp) {
    const g = (grupp && grupp.id) || '?';
    if (post.id) return { stable: `g:${g}|id:${post.id}`, externalId: 'fb:' + post.id };
    const h = texthash(post.text);
    const bucket = Math.floor(Date.now() / DEDUP_WINDOW_MS).toString(36);
    return { stable: `g:${g}|tx:${h}`, externalId: `fb:${g}:${h}:${bucket}` };
  }

  /* ---- Först sedd: bryggans egen observation ---------------------------
   *
   * EGEN NYCKEL, INTE pv.fb.seen.v2. Två skäl, båda mätta:
   *
   *   1. Olika livslängd och olika innehåll. seen är en HANTERINGSLISTA:
   *      "det här inlägget är avbockat, rör det aldrig igen". Den skrivs
   *      först när ett inlägg passerat hela kedjan, och isHandled() gör
   *      `continue` innan vi hunnit anteckna något. Först sedd måste
   *      tvärtom skrivas för VARJE inlägg i flödet, direkt när det syns,
   *      också för de som parsern strax kastar — annars ser ett inlägg som
   *      i går var ointressant nyfött ut i morgon.
   *   2. seen hålls medvetet bara i sidan under torrkörning, så att en
   *      torrkörning inte "bränner" inläggen inför skarpt läge. Först sedd
   *      bockar inte av någonting och ska tvärtom överleva torrkörningen:
   *      annars vore torrkörningen inte samma sak som skarpt läge, och det
   *      är hela poängen med den.
   *
   * Namnet börjar med avsikt INTE på "pv.fb.seen" — det är prefixet testet
   * använder för att bevisa att torrkörningen inte rör hanteringslistan.
   */
  const FORSTSEDD_KEY = 'pv.fb.forstsedd.v1';
  const FORSTSEDD_TTL = 24 * 3600 * 1000;
  const FORSTSEDD_MAX = 500;
  const FORSTSEDD_SKRIVPAUS = 5 * 60 * 1000;

  /*
   * Raderna är korta med flit — listan ligger i localStorage och läses vid
   * varje uppstart.
   *   f = första observationen (ms)
   *   s = senaste observationen (ms), styr gallringen
   *   k = 1 om raden skrevs under kalibreringssvepet, se nedan
   */
  let forstSedd = (() => {
    try {
      const rad = JSON.parse(localStorage.getItem(FORSTSEDD_KEY));
      return (rad && typeof rad === 'object') ? rad : {};
    } catch { return {}; }
  })();
  let forstSeddSkrivet = 0;

  /*
   * Listan får inte växa fritt. Ett flöde kan rulla förbi hundratals inlägg
   * på ett dygn, och localStorage har ett tak på några megabyte som delas
   * med resten av appen — spräcks det slutar ALLT skrivande fungera, tyst.
   *
   * Gallringen går på s (senast sedd), inte f (först sedd). Går den på f
   * faller ett inlägg som fortfarande ligger kvar i flödet ur listan efter
   * ett dygn, registreras om vid nästa svep, och får då plötsligt åldern
   * "noll minuter" — alltså precis det fel den här mekaniken finns för att
   * undvika. Ett inlägg som syns hålls levande.
   *
   * Kvar finns en smal risk: ett inlägg som trängts ut av taket och långt
   * senare skrollas fram igen ser nytt ut. Taket är satt så att det ska
   * krävas 500 andra inlägg först, och ett flöde visar en handfull åt
   * gången, så det förutsätter mycket skrollande. Den risken är känd och
   * accepterad, inte förbisedd.
   */
  /*
   * TVÅ FLIKAR DELAR DEN HÄR NYCKELN. Skrivningen måste därför slå ihop.
   *
   * Sedan brygg-daemonen läser flera grupper står två flikar på facebook.com
   * samtidigt, en per grupp, med var sin injicerad kopia av den här koden.
   * De delar localStorage. Den gamla versionen skrev hela objektet rakt av,
   * alltså: sista skrivningen vann och raderade den andra flikens rader.
   *
   * Nycklarna krockar inte — de bär gruppen sedan 2.3, `g:<gid>|…` — så en
   * hopslagning är entydig och förlustfri. Den som förlorar en rad förlorar
   * inte en varning direkt, men något värre och tystare: inlägget
   * registreras om, och är fliken redan kalibrerad kan ett gammalt inlägg då
   * få en färsk observerad ålder. Det är exakt det fel kalibreringssvepet
   * finns för att omöjliggöra.
   *
   * Två rader för samma nyckel slås ihop ÅT DET FÖRSIKTIGA HÅLLET:
   *
   *   f  tidigaste observationen. Inlägget fanns bevisligen redan då.
   *   s  senaste observationen. Styr gallringen; det som syns hålls levande.
   *   k  1 om NÅGON av dem såg inlägget under ett kalibreringssvep. Då är
   *      åldern okänd, och okänd ålder betyder att inget skickas. Motsatt
   *      regel (k=0 vinner) hade låtit en flik som råkade se inlägget "dyka
   *      upp" ge det en ålder som den andra flikens mätning motsäger.
   */
  function slaIhopForstSedd(a, b) {
    if (!a) return b;
    if (!b) return a;
    return { f: Math.min(a.f, b.f), s: Math.max(a.s, b.s), k: (a.k || b.k) ? 1 : 0 };
  }

  function sparaForstSedd() {
    const cutoff = Date.now() - FORSTSEDD_TTL;

    let lagrat = {};
    try {
      const r = JSON.parse(localStorage.getItem(FORSTSEDD_KEY));
      if (r && typeof r === 'object') lagrat = r;
    } catch {}

    const samlat = Object.assign({}, lagrat);
    for (const [k, v] of Object.entries(forstSedd)) samlat[k] = slaIhopForstSedd(lagrat[k], v);

    /*
     * Taket räknas PER GRUPP, inte över hela listan.
     *
     * Med ett delat tak hade en pratsam grupp trängt ut en tyst grupps rader
     * helt, och den tysta gruppen hade då tappat sin tidsmätning utan att
     * någon rad i loggen sa varför. Femhundra rader per grupp är samma
     * utrymme per grupp som förut, och en handfull grupper ryms med god
     * marginal i localStorage.
     */
    const perGrupp = new Map();
    for (const [k, v] of Object.entries(samlat)) {
      if (!v || !Number.isFinite(v.f) || !Number.isFinite(v.s) || v.s <= cutoff) continue;
      const m = /^g:([^|]*)\|/.exec(k);
      const gid = m ? m[1] : '?';
      if (!perGrupp.has(gid)) perGrupp.set(gid, []);
      perGrupp.get(gid).push([k, v]);
    }
    const kvar = [];
    for (const rader of perGrupp.values()) {
      rader.sort((a, b) => b[1].s - a[1].s);
      for (const r of rader.slice(0, FORSTSEDD_MAX)) kvar.push(r);
    }

    forstSedd = Object.fromEntries(kvar);
    forstSeddSkrivet = Date.now();
    try { localStorage.setItem(FORSTSEDD_KEY, JSON.stringify(forstSedd)); } catch {}
  }

  /*
   * KALLSTARTEN ÄR DET SVÅRA FALLET.
   *
   * Vid första svepet efter att fliken öppnats är varenda inlägg "nytt för
   * bryggan" — men flödet kan lika gärna innehålla inlägg från förra
   * veckan. Skulle observationen räknas där blev varje gammalt inlägg en
   * färsk varning på kartan i samma sekund som ägaren öppnar gruppen. Det
   * är samma fel som 2.1 rättade, bara med en ny orsak.
   *
   * Därför är första svepet ett KALIBRERINGSSVEP: alla inlägg som syns då
   * registreras med k = 1 och får aldrig någon observerad ålder, hur många
   * svep som än går. Bara inlägg som dyker upp i ett SENARE svep har
   * bevisligen tillkommit medan bryggan tittade, och bara de får åldern
   * "nu − först sedd".
   *
   * Flaggan är per flik, inte sparad. Efter en omladdning är det ett nytt
   * kalibreringssvep — men rader som redan ligger i localStorage behåller
   * sitt f och sitt k, så ett inlägg bryggan tidsbestämde i går är
   * tidsbestämt även efter omladdningen. Det är hela vinsten med att lägga
   * listan på disk i stället för i minnet.
   *
   * EN FLAGGA PER GRUPP, INTE EN FÖR HELA FLIKEN.
   *
   * Facebook byter sida utan att ladda om. Går ägaren från Västeråsgruppen
   * till Stockholmsgruppen är fliken densamma, och med en enda flagga vore
   * Stockholmsgruppens FÖRSTA svep redan "kalibrerat" — varenda inlägg som
   * råkade ligga i flödet, hur gammalt det än var, hade fått en observerad
   * ålder och blivit en färsk varning. Det är exakt det fel
   * kalibreringssvepet finns för att stoppa, bara med en ny väg in.
   */
  const kalibrerade = new Set();

  /*
   * ANDRA SÄTTET ATT SE GAMMALT SOM NYTT: flödet växer nedåt.
   *
   * "Fanns inte i förra svepet" räcker inte som bevis på att ett inlägg är
   * nytt, och det är inte bara kallstarten som spökar. Två vardagliga fall
   * lägger till inlägg efter kalibreringssvepet utan att något hänt:
   *
   *   • Ägaren skrollar. Facebook laddar då in nästa sida av flödet, och de
   *     inläggen kan vara veckogamla.
   *   • Sidan renderar färdigt. Vid uppstart finns bara de översta inläggen
   *     i DOM:en; resten dyker upp under de närmaste sekunderna.
   *
   * Båda lägger inläggen NEDANFÖR det bryggan redan sett. Ett genuint nytt
   * inlägg gör tvärtom: Facebook lägger det överst, alltså ovanför inlägg
   * bryggan redan känner igen.
   *
   * Alltså: en observation räknas bara om det finns minst ett redan känt
   * inlägg LÄNGRE NER i flödet. Regeln faller åt rätt håll — känner bryggan
   * inte igen något alls blir svaret "vet inte", och då skickas ingenting.
   */
  function registreraSedda(poster, grupp) {
    const nu = Date.now();
    const nycklar = poster.map(p => keysFor(p, grupp).stable);
    const kant = nycklar.map(k => !!(forstSedd[k] && Number.isFinite(forstSedd[k].f)));

    // Bakifrån: finns det ett redan känt inlägg nedanför position i?
    const kantNedanfor = new Array(poster.length).fill(false);
    let sett = false;
    for (let i = poster.length - 1; i >= 0; i--) {
      kantNedanfor[i] = sett;
      if (kant[i]) sett = true;
    }

    const arKalibrerad = kalibrerade.has(grupp.id);
    let nyRad = false;
    for (let i = 0; i < poster.length; i++) {
      const rad = forstSedd[nycklar[i]];
      if (rad && Number.isFinite(rad.f)) { rad.s = nu; continue; }
      const genuintNytt = arKalibrerad && kantNedanfor[i];
      forstSedd[nycklar[i]] = { f: nu, s: nu, k: genuintNytt ? 0 : 1 };
      nyRad = true;
    }

    kalibrerade.add(grupp.id);
    // Skriv när något nytt tillkommit, annars sällan: s uppdateras varje
    // svep och det vore 4 320 skrivningar per dygn för ingen nytta.
    if (nyRad || nu - forstSeddSkrivet > FORSTSEDD_SKRIVPAUS) sparaForstSedd();
  }

  /** @returns {number|null} ms för första observationen, eller null när den inte får användas. */
  function observeradTid(nyckel) {
    if (!CONFIG.firstSeenAge) return null;
    const rad = forstSedd[nyckel];
    if (!rad || !Number.isFinite(rad.f)) return null;
    if (rad.k) return null;              // sett under kalibreringssvepet — åldern är okänd
    return rad.f;
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

  /*
   * Aliaslistan: platsnamn som gruppen skriver -> söksträng som går att slå
   * upp. Samma tabell som data/aliases.vasteras.json, ord för ord.
   *
   * VARFÖR EN KOPIA OCH INTE FILEN. Sidan kör på facebook.com. Den kan inte
   * läsa en fil ur appen, och ett nätanrop till polisvakt.pages.dev härifrån
   * vore precis den trafik läsdelen inte får ha. Tabellen måste finnas i
   * koden.
   *
   * VARFÖR HÄR OCH INTE I GEOKODNINGSAVSNITTET. Allt före rubriken
   * "Geokodning" är LÄSDELEN, och läsdelen är det tools/brygg-daemon.ps1
   * jämför tecken för tecken mellan den här filen och Chrome-tilläggets
   * kopia. En aliasrad som glidit isär mellan de två filerna ger en nål på
   * fel plats i den ena — exakt den sortens tysta fel jämförelsen finns för.
   * Ligger tabellen innanför läsdelen kan den inte glida isär utan att
   * daemonen vägrar starta.
   *
   * MÄTT 2026-08-22, och det är därför den här listan finns: bryggan skickade
   * parserns platsnyckel rakt till uppslagstjänsten, i ett enda anrop.
   * 'irstamacken, Västerås' gav noll träffar, alltså publicerades inlägget
   * "Irstamacken" aldrig — och nollsvaret cachades dessutom utan TTL, så
   * platsen var död även efter att aliasfilen lagats. 'apalby ip, Västerås'
   * gav Apalbyvägen i Norrmalm, 1,7 km från Apalby IP, med tilliten 0,95.
   * Appen klarade båda, eftersom js/geocode.js slår i aliasfilen först.
   * Vinsten av nya namn i aliasfilen landade alltså bara i appen och inte i
   * den kanal som faktiskt läser gruppen.
   *
   * Nycklarna är gemener utan skiljetecken, precis som i filen: samma form
   * som normalize() ger. Tabellen gäller VÄSTERÅS och används därför bara för
   * grupper med den orten — se uppslaget i geocode().
   */
  const ALIAS_VASTERAS = {
    'dillos': 'Dillos, Västerås',
    'dillos pizzeria': 'Dillos, Västerås',
    'erikslund': 'Erikslunds köpcentrum, Västerås',
    'erikslundsrondellen': 'Erikslund, Västerås',
    'hälla': 'Hälla, Västerås',
    'hälla köpcentrum': 'Hälla köpcentrum, Västerås',
    'gallerian': 'Punkt Västerås',
    'punkt': 'Punkt Västerås',
    'resecentrum': 'Västerås centralstation',
    'centralen': 'Västerås centralstation',
    'stationen': 'Västerås centralstation',
    'flygplatsen': 'Stockholm Västerås Airport',
    'hamnen': 'Västerås hamn',
    'abb': 'ABB, Västerås',
    'sjukhuset': 'Västmanlands sjukhus Västerås',
    'lasarettet': 'Västmanlands sjukhus Västerås',
    'mdh': 'Mälardalens universitet, Västerås',
    'mdu': 'Mälardalens universitet, Västerås',
    'bombardier': 'Hallstahammarsvägen, Västerås',
    'rocklunda': 'Rocklunda, Västerås',
    'arenan': 'ABB Arena, Västerås',
    'abb arena': 'ABB Arena Nord, Västerås',
    'djurgårdsvägen': 'Djurgårdsvägen, Västerås',
    'apalby': 'Apalby, Västerås',
    'apalby ip': 'Apalby, Västerås',
    'irstamacken': 'Circle K, Irsta',
    'emausskolan': 'Emausskolan, Västerås',
    'hemköp öster mälarstrand': 'Hemköp Västerås Öster Mälarstrand',
    'vallby golfklubb': 'Västerås golfklubb, Vallby',
    'vallby golfklubben': 'Västerås golfklubb, Vallby',
    'västerås golfklubb': 'Västerås golfklubb, Vallby',
    'hammarby': 'Hammarby, Västerås',
    'hammarbyrampen': 'Hammarby, Västerås',
    'bäckby': 'Bäckby, Västerås',
    'backby': 'Bäckby, Västerås',
    'vallby': 'Vallby, Västerås',
    'pettersberg': 'Pettersberg, Västerås',
    'råby': 'Råby, Västerås',
    'raby': 'Råby, Västerås',
    'bjurhovda': 'Bjurhovda, Västerås',
    'skiljebo': 'Skiljebo, Västerås',
    'malmaberg': 'Malmaberg, Västerås',
    'viksäng': 'Viksäng, Västerås',
    'viksang': 'Viksäng, Västerås',
    'gideonsberg': 'Gideonsberg, Västerås',
    'skallberget': 'Skallberget, Västerås',
    'jakobsberg': 'Jakobsberg, Västerås',
    'blåsbo': 'Blåsbo, Västerås',
    'emaus': 'Emaus, Västerås',
    'nordanby': 'Nordanby, Västerås',
    'önsta': 'Önsta-Gryta, Västerås',
    'gryta': 'Önsta-Gryta, Västerås',
    'hökåsen': 'Hökåsen, Västerås',
    'hokasen': 'Hökåsen, Västerås',
    'skultuna': 'Skultuna',
    'irsta': 'Irsta',
    'barkarö': 'Barkarö',
    'tillberga': 'Tillberga',
    'dingtuna': 'Dingtuna',
    'badelunda': 'Badelunda',
    'tortuna': 'Tortuna',
    'kungsåra': 'Kungsåra',
    'romfartuna': 'Romfartuna',
    'lillhärad': 'Lillhärad',
    'gäddeholm': 'Gäddeholm, Västerås',
    'johannisberg': 'Johannisberg, Västerås',
    'öster mälarstrand': 'Öster Mälarstrand, Västerås',
    'lillåudden': 'Lillåudden, Västerås',
    'stora gatan': 'Stora gatan, Västerås',
    'vasagatan': 'Vasagatan, Västerås',
    'kopparbergsvägen': 'Kopparbergsvägen, Västerås',
    'björnövägen': 'Björnövägen, Västerås',
    'bjornovagen': 'Björnövägen, Västerås',
    'norrleden': 'Norrleden, Västerås',
    'österleden': 'Österleden, Västerås',
    'västerleden': 'Västerleden, Västerås',
    'bergslagsvägen': 'Bergslagsvägen, Västerås',
    'köpingsvägen': 'Köpingsvägen, Västerås',
    'surahammarsvägen': 'Surahammarsvägen, Västerås',
    'pilgatan': 'Pilgatan, Västerås',
    'sigurdsgatan': 'Sigurdsgatan, Västerås',
    'ängsgärdsgatan': 'Ängsgärdsgatan, Västerås',
    'e18': 'E18, Västerås',
    'e18 västerut': 'E18, Västerås',
    'e18 österut': 'E18, Västerås',
    'riksväg 66': 'Riksväg 66, Västmanland',
    'rv66': 'Riksväg 66, Västmanland',
    '66an': 'Riksväg 66, Västmanland',
    'riksväg 56': 'Riksväg 56, Västmanland',
    'rv56': 'Riksväg 56, Västmanland',
    '56an': 'Riksväg 56, Västmanland',
    'räta linjen': 'Riksväg 56, Västmanland',
    'sala': 'Sala',
    'köping': 'Köping',
    'arboga': 'Arboga',
    'fagersta': 'Fagersta',
    'hallstahammar': 'Hallstahammar',
    'surahammar': 'Surahammar',
    'kungsör': 'Kungsör',
    'norberg': 'Norberg',
    'skinnskatteberg': 'Skinnskatteberg',
    'kvicksund': 'Kvicksund',
  };

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
   * appen ljuger. Därför kontrolleras varje koordinat mot gruppens egen ruta
   * här också, både färska svar och det som ligger i cachen.
   *
   * Sedan 2.3 är det gruppens ruta och inte en global. Det är samma spärr
   * som förut för Västeråsgruppen, men den gör nu ett andra jobb: den hindrar
   * en Stockholmsvarning från att hamna på Västeråskartan även när båda
   * grupperna är anslutna i samma flik.
   */
  const inomOmradet = (lat, lon, ruta) =>
    Number.isFinite(lat) && Number.isFinite(lon) && giltigRuta(ruta) &&
    lon >= ruta[0] && lon <= ruta[2] &&
    lat >= ruta[1] && lat <= ruta[3];

  /*
   * CACHENYCKELN BÄR GRUPPEN, och det är inte kosmetik.
   *
   * "Storgatan" finns i varenda svensk stad. Slog Västeråsgruppen upp den
   * först och Stockholmsgruppen sedan läste ur samma cache, fick Stockholm
   * Västerås koordinat — en varning på fel plats, alltså precis det fel som
   * lär föraren att appen ljuger. Nyckeln är därför per grupp.
   */
  async function geocode(place, grupp) {
    const key = 'pv.fb.geo.' + grupp.id + '.' + normalize(place);
    const cached = localStorage.getItem(key);
    if (cached) {
      try {
        const c = JSON.parse(cached);
        if (!c) return null;                       // negativt svar, sparat med flit
        if (inomOmradet(c.lat, c.lon, grupp.ruta)) return c;
        localStorage.setItem(key, 'null');         // förgiftad rad, kasta den
        return null;
      } catch {}
    }

    // Nominatim tillåter ett anrop i sekunden. Vi köar snällt.
    const wait = 1200 - (Date.now() - lastGeocode);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastGeocode = Date.now();

    // Nämner texten redan orten eller landskapet blir "Vasagatan, Västerås,
    // Västerås" bara sämre att slå upp. Annars hjälper suffixet Nominatim
    // att välja rätt av tjugo gator med samma namn.
    const lagt = normalize(place);

    /*
     * ALIASNYCKELN FÖRST, precis som js/geocode.js gör innan den frågar
     * uppslagstjänsten. Parsern lägger numera medvetet ut EXAKTA
     * aliasnycklar ("irstamacken", "apalby ip"), och just de nycklarna är
     * sådana OSM inte känner igen i rå form — se motiveringen vid
     * ALIAS_VASTERAS. Utan uppslaget blev vinsten av varje nytt namn i
     * aliasfilen appens ensam, medan bryggan fick noll träffar eller fel
     * koordinat.
     *
     * Tabellen är Västerås, alltså används den bara för Västeråsgrupper. En
     * Stockholmsgrupp som slog upp "vasagatan" ur den här listan hade fått
     * Västerås koordinat — samma fel som cachenyckeln per grupp redan
     * skyddar mot, och det värsta utfall den här appen har.
     */
    const forVasterAs = normalize(grupp.ort) === 'västerås';
    const alias = forVasterAs
      ? (ALIAS_VASTERAS[lagt] || ALIAS_VASTERAS[lagt.replace(/\s+/g, '')])
      : null;

    const harOrt = grupp.orter.some(o => o && lagt.includes(o));
    const fraga = alias || ((harOrt || !grupp.ort) ? place : place + ', ' + grupp.ort);

    const u = new URL('https://nominatim.openstreetmap.org/search');
    u.searchParams.set('q', fraga);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('limit', '1');
    u.searchParams.set('countrycodes', 'se');
    u.searchParams.set('viewbox', grupp.ruta.join(','));
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
    if (!inomOmradet(hit.lat, hit.lon, grupp.ruta)) {
      localStorage.setItem(key, 'null');
      console.warn(TAG, 'träff utanför ' + (grupp.omrade || grupp.ort || grupp.id) +
        ' kastad:', place, hit.lat, hit.lon);
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

  /*
   * SLUG ELLER SIFFROR — fällan som blir värre ju fler grupper man ansluter.
   *
   * Facebook byter mellan gruppens siffer-id och dess slug i adressfältet.
   * Står det ena i konfigurationen och det andra i adressen läser bryggan
   * ingenting, och tystnaden ser exakt ut som ett tomt flöde. Med en enda
   * grupp märker man det till slut. Med fem, anslutna via appens lista där
   * upptäckten ger den form Facebook råkar visa, är det nästan garanterat
   * att minst en av dem tystnar.
   *
   * Gruppens siffer-id går att läsa ur sidan även när adressen bär sluggen.
   * MÄTT PÅ EN RIKTIG GRUPPSIDA, /groups/norti.se/, länkarnas former:
   *
   *   /groups/291829374617173/user/…        48 st   ← sidans EGEN grupp
   *   /groups/291829374617173/members/       2 st
   *   /groups/291829374617173/yourposts/     2 st
   *   /groups/1009040832459849/              1 st   ← ANNAN grupp, sidomenyn
   *   /groups/317968668373072/               1 st   ← ANNAN grupp, sidomenyn
   *
   * De två sista raderna är hela skälet till att regexen nedan är smal. Den
   * sista är dessutom Västeråsgruppen — alltså den anslutna gruppen, länkad
   * från en sida som tillhör en HELT ANNAN grupp. En bred sökning efter
   * "något siffer-id i DOM:en" hade matchat den och fått bryggan att läsa
   * biljettgruppens inlägg som om de kom från polisgruppen. Det är läckan
   * mätningen letade efter, och den är verklig.
   *
   * Bara /user/, /posts/ och /permalink/ räknas därför: de länkarna finns
   * bara inuti gruppens eget innehåll. Sidomenyns länkar går till roten och
   * matchar inte. Hittas mer än ett id är sidan inte en gruppsida, och då
   * svarar funktionen "vet inte" — vilket betyder tystnad.
   */
  const EGET_GRUPPID = /\/groups\/(\d{6,})\/(?:user|posts|permalink)\//;

  function sifferIdIDom() {
    const funna = new Set();
    for (const a of document.querySelectorAll('a[href*="/groups/"]')) {
      const m = EGET_GRUPPID.exec(a.getAttribute('href') || '');
      if (!m) continue;
      funna.add(m[1]);
      if (funna.size > 1) return null;      // flera grupper i DOM:en = inte en gruppsida
    }
    return funna.size === 1 ? [...funna][0] : null;
  }

  /**
   * Vilken ansluten grupp tittar vi på just nu? null när svaret inte är säkert.
   *
   * Uppslaget kan bara peka ut grupper som redan står i listan. Det kan
   * alltså aldrig öppna bryggan för en grupp ägaren inte anslutit — det kan
   * bara känna igen en ansluten grupp under ett annat namn.
   */
  function aktivGrupp() {
    const seg = currentGroupId();
    if (!seg) return null;
    if (FORBJUDNA_GRUPPORD.has(seg.toLowerCase())) return null;

    const direkt = gruppMedId(seg);
    if (direkt) return direkt;

    // Siffror i adressen är redan den entydiga formen. Matchar de ingen
    // ansluten grupp är svaret nej, och att då börja leta i DOM:en vore att
    // leta efter en ursäkt att läsa.
    if (/^\d+$/.test(seg)) return null;

    const nr = sifferIdIDom();
    return nr ? gruppMedId(nr) : null;
  }

  let running = false;
  const nämndaFelGrupper = new Set();
  const tally = { created: 0, duplicates: 0, refused: 0, skipped: 0, failed: 0,
                  utanTid: 0, observerade: 0 };

  async function scan() {
    if (running) return;

    // Bälte och hängslen: startspärren nedan hindrar redan att skriptet kommer
    // hit utan grupper, men scan går också att kalla för hand från konsolen.
    // Förut stod det `CONFIG.groupId && gid !== CONFIG.groupId`, vilket betydde
    // att ett tomt fält släppte igenom varje grupp just här.
    if (!GRUPPER.length) return;

    const grupp = aktivGrupp();
    if (!grupp) {
      // Tystnaden ser likadan ut som "inga inlägg". En rad i konsolen per
      // grupp, en gång, så att ägaren märker att han står i fel grupp.
      const gid = currentGroupId();
      if (gid && !FORBJUDNA_GRUPPORD.has(gid.toLowerCase()) && !nämndaFelGrupper.has(gid)) {
        nämndaFelGrupper.add(gid);
        console.log(TAG, 'du är i grupp ' + gid + ' men bryggan lyssnar på ' +
          GRUPPER.map(g => g.id).join(', ') + ' — inget läses här.');
      }
      return;
    }

    running = true;
    try {
      const poster = collectPosts();

      /*
       * Registreringen går FÖRE hanteringen och gäller varje inlägg i
       * flödet, även de isHandled() strax hoppar över och de parsern strax
       * kastar. Frågan "fanns det här i förra svepet?" måste kunna
       * besvaras för alla, annars ser ett inlägg som en gång var
       * ointressant nyfött ut nästa gång det passerar.
       */
      registreraSedda(poster, grupp);

      for (const post of poster) {
        const { stable, externalId } = keysFor(post, grupp);
        if (isHandled(stable)) continue;

        // platsKonvention: bryggan läser bara gruppflödet, och där gäller
        // gruppens egen regel — man skriver enbart när man ser en
        // poliskontroll. Samma flagga sätts i js/facebook.js.
        const parsed = parseReportText(post.text, { platsKonvention: true });

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
         *
         * Tre vägar till åldern, i den här ordningen:
         *
         *   1. Facebooks egen tid, läst ur DOM:en. Exaktast — den säger när
         *      inlägget skrevs, inte när vi råkade titta. Den vinner alltid
         *      när den finns, men är sedan 2.2 inget krav.
         *   2. Bryggans första observation. Finns bara för inlägg som dykt
         *      upp efter kalibreringssvepet, och då med en osäkerhet på ett
         *      svepintervall. Det räcker gott: varningarna lever 30–60
         *      minuter.
         *   3. Hovring. Avstängd som förval, se CONFIG.hoverForTime.
         *
         * Går ingen av dem fram är åldern okänd, och då skickas ingenting.
         * Den spärren är kvar och ska vara kvar.
         */
        let postedAt = post.postedAt;
        let tidKalla = 'facebook';
        if (postedAt == null) {
          postedAt = observeradTid(stable);
          if (postedAt != null) { tidKalla = 'observation'; tally.observerade++; }
        }
        if (postedAt == null && CONFIG.hoverForTime) {
          postedAt = await tidGenomHovring(post.tidsAnkare);
          tidKalla = 'hovring';
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
          hit = await geocode(parsed.place, grupp);
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
            '(' + Math.round(parsed.confidence * 100) + '%, ålder från ' + tidKalla + ')', row);
          markDone(stable);
          tally.created++;
          continue;
        }

        try {
          const inserted = await send(row);
          markDone(stable);
          if (inserted) {
            tally.created++;
            console.log(TAG, 'skickad:', row.type, row.label, '(ålder från ' + tidKalla + ')');
          }
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

  if (GRUPPFEL) {
    console.error(TAG, GRUPPFEL);
    return;      // ingen timer, ingen observatör — skriptet gör ingenting
  }

  if (!GRUPPER.length) {
    console.error(TAG, 'CONFIG.groupIds är tom — bryggan startar inte. ' +
      'Öppna gruppen, kopiera det som står efter /groups/ i adressen, och ' +
      'lägg in det i CONFIG.groupIds. Enklast är Inställningar → ' +
      'Facebook-grupper i appen, som skriver hela listan åt dig. Utan ' +
      'spärren hade skriptet läst varje grupp kontot är med i.');
    return;      // ingen timer, ingen observatör — skriptet gör ingenting
  }

  console.log(TAG, 'Facebook-bryggan är igång för grupp' +
    (GRUPPER.length > 1 ? 'erna ' : ' ') +
    GRUPPER.map(g => g.id + ' (' + g.namn + ')').join(', ') + '.' +
    (CONFIG.dryRun ? ' Torrkörning: inget skickas.' : ' Skarpt läge.') +
    (CONFIG.firstSeenAge
      ? ' Första svepet är ett kalibreringssvep — inget skickas på egen observation ' +
        'förrän ett inlägg dykt upp EFTER det.'
      : ' Ålder mäts bara på Facebooks egen tidsstämpel.'));

  setTimeout(scan, 4000);
  setInterval(scan, CONFIG.scanIntervalMs);

  // Nya inlägg dyker upp när man skrollar, och Facebook byter sida utan att
  // ladda om. En debounce räcker — vi vill inte skanna vid varje DOM-ändring.
  let moTimer = null;
  new MutationObserver(() => {
    clearTimeout(moTimer);
    moTimer = setTimeout(scan, 3000);
  }).observe(document.body, { childList: true, subtree: true });

  /*
   * UPPTÄCK GRUPPERNA KONTOT ÄR MED I.
   *
   * MÄTT, inte gissat. På /groups/joins/ ("Dina grupper") ligger varje grupp
   * som en länk till /groups/<id>/ med namnet som text. Ett svep gav tio
   * grupper med rena namn, bland dem "Här Står Polisen - Västerås" på
   * 317968668373072. Skrollning laddade inte fler — listan står där direkt.
   *
   * Två saker att veta:
   *
   *   1. /groups/feed/ duger INTE. Där ligger bara de grupper som råkar ha
   *      ett inlägg i flödet just nu — uppmätt en enda av tio.
   *   2. Facebook skriver ibland sluggen i länken i stället för siffrorna
   *      ("norti.se"). Det är samma grupp, men bryggan känner inte igen den
   *      formen mot en konfiguration som bär siffrorna. Öppna gruppen och
   *      kör hittaGrupper() igen där, så plockas siffer-id:t ur sidan.
   *
   * Funktionen läser bara DOM:en. Inga anrop, ingenting sparas, ingenting
   * skickas.
   */
  function hittaGrupper() {
    const mall = new Map();
    for (const a of document.querySelectorAll('a[href*="/groups/"]')) {
      const href = (a.getAttribute('href') || '').split('?')[0].replace(/^https?:\/\/[^/]+/, '');
      const m = /^\/groups\/([^/?#]+)\/?$/.exec(href);
      if (!m) continue;
      const id = m[1];
      if (FORBJUDNA_GRUPPORD.has(id.toLowerCase())) continue;
      if (!mall.has(id)) mall.set(id, []);
      const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
      if (t) mall.get(id).push(t);
    }

    // Samma grupp länkas flera gånger: en gång med hela kortets text
    // ("Namnet Senast aktiv för en dag sedan") och en gång med bara namnet.
    // Kortast vinner — det är namnet, utan Facebooks påhäng.
    const ut = [];
    for (const [id, texter] of mall) {
      const rena = texter
        .filter(t => !/^(visa grupp|visa alla|gå med|bjud in|see group|join|view all)$/i.test(t))
        .sort((a, b) => a.length - b.length);
      ut.push({
        id,
        namn: (rena[0] || '').slice(0, 80) || id,
        ansluten: !!gruppMedId(id),
      });
    }
    if (!ut.length) {
      console.log(TAG, 'inga grupper hittades här. Öppna facebook.com/groups/joins/ ' +
        'och kör __polisvakt.hittaGrupper() igen.');
    }
    return ut;
  }

  // Handtag för felsökning i konsolen.
  window.__polisvakt = {
    scanNow: scan,
    grupper: () => GRUPPER.map(g => ({ ...g })),
    aktivGrupp: () => { const g = aktivGrupp(); return g ? { ...g } : null; },
    hittaGrupper,
    stats: () => ({ ...tally, ihagkomna: Object.keys(seen).length,
                    forstSedda: Object.keys(forstSedd).length,
                    kalibrerade: [...kalibrerade] }),
    peek: () => collectPosts(),
    parse: parseReportText,
    // Felsökning av just tidsstämpeln — det som gick sönder tyst förut.
    tider: () => collectPosts().map(p => {
      const nyckel = keysFor(p, aktivGrupp()).stable;
      const obs = observeradTid(nyckel);
      const t = p.postedAt != null ? p.postedAt : obs;
      return {
        text: p.text.slice(0, 60),
        id: p.id,
        postedAt: p.postedAt,
        forstSedd: forstSedd[nyckel] || null,
        kalla: p.postedAt != null ? 'facebook' : (obs != null ? 'observation' : null),
        alder: t == null ? 'OLÄSLIG' : Math.round((Date.now() - t) / 60000) + ' min',
        tidText: p.tidsAnkare ? synligText(p.tidsAnkare) : null,
      };
    }),
    forstSedda: () => ({ ...forstSedd }),
    tolkaTid,
    synligText,
    forget: () => {
      seen = {}; localStorage.removeItem(SEEN_KEY);
      forstSedd = {}; kalibrerade.clear(); localStorage.removeItem(FORSTSEDD_KEY);
      console.log(TAG, 'minneslistan tömd — nästa svep blir ett nytt kalibreringssvep');
    },
  };
})();

/*
 * ================= MÄTT I EN RIKTIG BAKGRUNDSFLIK =================
 *
 * Chrome 148, Windows 11, en flik som låg dold (document.visibilityState
 * === 'hidden') hela mätningen, elva minuter. Siffrorna är avlästa, inte
 * hämtade ur dokumentationen.
 *
 * 1. setInterval(20000) — bryggans svepklocka
 *
 *      20, 20, 20, 20, 20, 35, 60, 60, 60, 60, 60, 60, 60 sekunder
 *
 *    De två första minuterna hålls tjugosekundersintervallet exakt. Sedan
 *    slår Chromes hårda strypning till och fliken får en enda väckning per
 *    minut. Efter det är svepintervallet 60 s vad man än skriver i
 *    scanIntervalMs — kortare värden ger ingenting, längre värden gäller.
 *
 *    Konsekvens: ett nytt inlägg upptäcks inom 20 s de första två
 *    minuterna, därefter inom 60 s. Varningarna lever 30–60 minuter, så en
 *    minut kostar mellan 2 och 3 procent av livslängden. Åldern blir
 *    däremot osäkrare i samma takt: mät den till "0 min" och den kan i
 *    värsta fall vara 60 s gammal.
 *
 * 2. Layout och geometri fungerar i en dold flik
 *
 *      getBoundingClientRect() på ett ankare: 36 × 18 px
 *      getBoundingClientRect() på ett teckenspann inuti: 6 × 18 px
 *      innerText: icke-tom
 *
 *    Det var det som gjorde bakgrundskörning möjlig över huvud taget.
 *    synligText() läser teckenspannen geometriskt, och den avläsningen
 *    kräver alltså inte förgrund — bara att grenen är renderad. Hela det
 *    här testsvepet (117 fall, inklusive "teckenspann läses geometriskt")
 *    kördes i en dold flik.
 *
 * 3. MutationObserver stryps inte
 *
 *      Ett tillägg i DOM:en → callback efter 0 ms, även dold.
 *
 *    Observatören märker alltså nya inlägg direkt. Dess debounce ligger
 *    dock på setTimeout, och den stryps (se punkt 4).
 *
 * 4. Hovringen går sönder i bakgrunden — det starkaste skälet till att
 *    den numera är av
 *
 *    tidGenomHovring() pollar verktygstipset HOVER_FORSOK (12) gånger med
 *    HOVER_PAUS_MS (70 ms) emellan, alltså ~840 ms i förgrunden. Samma
 *    loop, samma kod, i en dold flik — millisekunder per varv:
 *
 *      1007, 1004, 989, 1007, 993, 47003, 60007, …
 *
 *    De fem första varven klaras av på strypningens sekundgolv. Sedan är
 *    flikens väckningsbudget slut och varje ytterligare varv får vänta på
 *    nästa minutväckning. Mätningen avbröts efter sju varv (112 sekunder);
 *    fortsätter mönstret hamnar tolv varv kring sju minuter i stället för
 *    under en sekund. Räkna inte med exakt sju — räkna med minuter.
 *
 *    Och scan() håller sitt running-lås hela tiden. EN hovring i en dold
 *    flik räcker alltså för att stoppa bryggans läsning i minuter.
 *
 *    Först-sedd-mätningen kostar noll timers och noll millisekunder.
 *    Behöver du hovringen får fliken ligga i förgrunden.
 *
 * 5. Det här är INTE mätt, och ska inte påstås
 *
 *    Om Facebook själv skjuter in nya inlägg i DOM:en medan fliken är dold,
 *    eller sparar dem till en "Nya inlägg"-knapp som kräver ett klick. Ser
 *    inte bryggan inlägget spelar ingen strypning någon roll. Kör en kväll
 *    med dryRun: true och en dold flik och titta på __polisvakt.stats()
 *    innan du litar på obevakad drift.
 */
