/*
 * Registreringsnummer i fritext — hittar skyltar i det folk SKRIVER.
 *
 * Skyltläsaren i plate.js läser kameran. Den här modulen läser text: ett
 * chattmeddelande, en rapport, en klistrad lista. Den finns för att svaret på
 * "någon nämnde ABC 123" ska kunna bli en knapp — "vill du lägga in numret i
 * ditt system också?" — och för att tio nummer i samma meddelande ska kunna
 * bli ett enda ja/nej i stället för tio inskrivningar.
 *
 * VAD SOM ÄR FARLIGT HÄR, OCH VARFÖR MODULEN SER UT SOM DEN GÖR
 *
 * Ett MISSAT nummer kostar användaren tio sekunder: hen skriver in det för
 * hand, precis som i dag. Ett FALSKT nummer kostar förtroendet — en knapp som
 * frågar "vill du lägga in 14:30 som ett fordon?" gör att nästa fråga, den
 * riktiga, också avfärdas. Och i bulkläget, där hela poängen är att svara ja
 * en gång, blir ett falsklarm dessutom osynligt: det åker in i registret
 * tillsammans med de riktiga.
 *
 * Därför lutar allt nedan åt samma håll: hellre tyst än fel. Det är samma
 * löfte som gränssnittet redan ger om kameraläsaren ("Den gissar inte. Hellre
 * inget svar än fel svar."), och det vore ohederligt att låta textvägen ha en
 * lösare tröskel bara för att den är billigare att bygga.
 *
 * DE TRE GRINDARNA
 *
 *   1. FORMATET. Ett svenskt nummer är tre bokstäver ur ett begränsat
 *      alfabet plus två siffror plus siffra-eller-bokstav. Sanningen om vad
 *      som är giltigt bor i plate.js `normaliseraPlat` och kopieras inte
 *      hit som en egen tolkning — se `normaliseraPlatKopia` nedan för hur
 *      kopian hålls ärlig, och `hittaRegnummer`s parameter `normalisera`
 *      för hur den riktiga funktionen injiceras när den går att ladda.
 *
 *      MEN: OCR-rättningen får INTE gälla här. `normaliseraPlat` rättar upp
 *      till två tecken, för att en kamera förväxlar 0 och O. Ett tangentbord
 *      gör inte det, och rättningen är förödande på ord: "BOSTAD" rättas till
 *      BOS74D och "SLOTTS" till SLO77S — båda formatgiltiga skyltar, båda
 *      rena påhitt. Därför krävs här att numret är giltigt UTAN rättning,
 *      alltså att normaliseringen lämnar tillbaka exakt det den fick in.
 *
 *   2. ORDGRÄNSEN. Träffen måste stå fritt. "länsväg 250" innehåller "väg
 *      250" men bokstavsgruppen sitter fast i ett längre ord, och då är det
 *      inte en skylt. Samma sak åt andra hållet ("ABC1234", "abc123def") och
 *      i webbadresser och filnamn ("exempel.se/abc123", "bild_abc123.jpg").
 *
 *   3. ORDVAKTEN. Tre bokstäver plus tre tecken är ett format som svenska
 *      texter träffar av misstag hela tiden: "rum 101", "fel 404", "hus 12A",
 *      "mot 500 kr", "lgh 120". Formatet ensamt kan inte skilja dem från en
 *      skylt, för de ÄR formatgiltiga. Två sådana ord finns listade i
 *      `ORDGARD` (bokstavsgruppen) och `EFTERORD` (enheten som följer på
 *      siffrorna), och båda leder till tystnad.
 *
 *      Priset är känt och accepterat: en riktig skylt som råkar stavas som
 *      ett av orden i `ORDGARD` — MOT 500, LED 250 — hittas inte automatiskt.
 *      Listan är ~130 av 12 167 möjliga bokstavskombinationer, alltså ungefär
 *      en procent av skyltarna, och de går fortfarande att skriva in för
 *      hand. Motsatt val — att ta med dem — gör "mot 500 kr" till ett fordon.
 *
 * Modulen rör ingen DOM, hämtar ingenting och sparar ingenting. Den tar en
 * sträng och lämnar en lista. Det är hela ytan, och det är därför den går att
 * testa på riktigt (prov/regnummer-test.html).
 */

/* ---- Kopian av formatsanningen -----------------------------------------
 *
 * Det riktiga hemmet för de här reglerna är js/plate.js. Att de står en gång
 * till här är ingen förbättring, det är en eftergift: plate.js rör `window`
 * på modulnivå (kameravillkoren) och kan därför inte importeras i en ren
 * JS-miljö utan DOM. En modul som bara går att testa i en webbläsare blir i
 * praktiken otestad, och den här modulen är hela försvaret mot falska
 * fordon i registret.
 *
 * Kopian är ordagrann — samma alfabet, samma förväxlingstabeller, samma tak
 * på två rättningar, samma delsträngsregel — och den hålls ärlig av ett
 * prov som kör den riktiga `normaliseraPlat` och den här sida vid sida över
 * en batteri av strängar (prov/regnummer-test.html, gruppen "Kopian mot
 * plate.js"). Går de isär faller provet.
 *
 * Den som har plate.js laddad ska hellre injicera den riktiga funktionen:
 *   import { normaliseraPlat } from './plate.js';
 *   hittaRegnummer(text, { normalisera: normaliseraPlat });
 */
const BOKSTAV     = 'ABCDEFGHJKLMNOPRSTUWXYZ';
const SISTBOKSTAV = 'ABCDEFGHJKLMNPRSTUWXYZ';
const PLATFORMAT  = new RegExp(`^[${BOKSTAV}]{3}[0-9]{2}[0-9${SISTBOKSTAV}]$`);

const TILL_BOKSTAV = { 0: 'O', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 8: 'B' };
const TILL_SIFFRA  = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2',
                       A: '4', S: '5', G: '6', T: '7', B: '8' };

/** Sex tecken in, skylt eller null ut. Ordagrann kopia av plate.js `rattaSex`. */
function rattaSex(s) {
  const tecken = s.split('');
  let rattade = 0;
  const ratta = (i, nytt) => { if (nytt && nytt !== tecken[i]) { tecken[i] = nytt; rattade++; } };

  for (let i = 0; i < 3; i++) {
    if (!BOKSTAV.includes(tecken[i])) ratta(i, TILL_BOKSTAV[tecken[i]]);
  }
  for (let i = 3; i < 5; i++) {
    if (!/[0-9]/.test(tecken[i])) ratta(i, TILL_SIFFRA[tecken[i]]);
  }
  if (!/[0-9]/.test(tecken[5]) && !SISTBOKSTAV.includes(tecken[5])) {
    ratta(5, TILL_SIFFRA[tecken[5]]);
  }
  if (rattade > 2) return null;

  const plat = tecken.join('');
  return PLATFORMAT.test(plat) ? plat : null;
}

/**
 * Ordagrann kopia av plate.js `normaliseraPlat` (via dess `tolkaRatext`).
 * Exporterad enbart för att provet ska kunna ställa den mot originalet.
 */
export function normaliseraPlatKopia(ratext) {
  const s = String(ratext || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === 6) return rattaSex(s);
  if (s.length !== 7 && s.length !== 8) return null;

  if (s.length === 7 && s[0] === 'S') {
    const p = rattaSex(s.slice(1));
    if (p) return p;
  }
  const funna = new Set();
  for (let i = 0; i + 6 <= s.length; i++) {
    const p = rattaSex(s.slice(i, i + 6));
    if (p) funna.add(p);
  }
  return funna.size === 1 ? [...funna][0] : null;
}

/* ---- Grind 3: orden ------------------------------------------------------
 *
 * Bokstavsgrupper som i svensk löptext nästan alltid är ett ord med ett tal
 * efter sig, inte en skylt. Bara grupper om exakt tre tecken har någon
 * verkan; resten står med för läsbarhetens skull.
 *
 * Urvalsregeln när listan ändras: ta bara med det som FAKTISKT följs av
 * siffror i text. "sol" behöver inte stå här, "sal" gör det. Varje tillägg
 * kostar en riktig skylt.
 */
const ORDGARD = new Set(`
  OCH ATT KAN SKA SOM DEN DET ETT HAN HON HAR HUR HEN MEN MER MOT NOG SEN SER
  TAR TOG TRE UPP NER HOS PER MED KOM GER GAV BOR ERA ENS HEM UTE ALL NYA
  RUM HUS SAL DEL LED TYP TAL ORD RAD SAK LAG KAP KOD MAX BOX ART REF NUM POS
  SID VER APP WEB FEL BAS DAG TON PAR LOT SUM ANT NOT MAT PRO PUB SKO SON TAK
  TAG TUR YTA RES RAS
  TEL MOB FAX SMS MMS LGH GPS UTC CET GMT DNS RAM ROM CPU GPU USB HDD SSD LCD
  PDF JPG PNG DOC EXE TXT HTM PHP CSS RGB HEX EAN SKU ABS ESP SUV AWD FWD RWD
  SEK EUR USD NOK DKK GBP CHF PLN CZK JPY CAD AUD KKR MKR TKR
  KWH KMH MPH KPH RPM BPM MHZ GHZ KHZ
  JAN FEB MAR APR MAJ JUN JUL AUG SEP OKT NOV DEC ONS TOR FRE
`.trim().split(/\s+/));

/*
 * Enheter som kan stå EFTER talet. Den här grinden fångar det `ORDGARD` inte
 * hann lista: vad "xyz 500" än betyder så är det inte ett fordon om nästa ord
 * är "kr". Bara entydiga enheter får stå här — "min" och "m" är uteslutna,
 * för "ABC123 min bil" är en fullt rimlig mening.
 */
const EFTERORD = new Set(`
  kr kronor sek euro eur usd dollar pund kwh kw km kmh km/h mph kg hg mg mm cm
  dm mil kvm st styck stycken procent hk nm liter dl cl ml mb gb tb kb rpm bpm
  tum grader meter lumen watt volt bar psi knop
`.trim().split(/\s+/));

/* ---- Grind 2: ordgränsen -------------------------------------------------
 *
 * Tecken som gör grannskapet till en adress, ett filnamn eller en parameter
 * i stället för löptext. De sneda strecken och krumeluren är webbadressens
 * skelett; likhetstecknet och &-tecknet är frågesträngens.
 *
 * Notera vilka som INTE står med: `*` och `_` används för fetstil och kursiv
 * i chattar, och `'` och `"` är citat. En skylt inuti *ABC123* eller "ABC123"
 * ska hittas. Understrecket hanteras i stället av tvåstegsregeln nedan, som
 * skiljer _abc123_ (kursivering) från bild_abc123 (filnamn).
 */
const ADRESSTECKEN_FORE = new Set(['/', '\\', '@', '#', '%', '=', '&', '?', '+', '|', '^']);
const ADRESSTECKEN_EFTER = new Set(['@', '#', '%', '=', '&', '|', '^']);
/* Tecken som är oskyldiga för sig men gör granne-granne till ett ord. */
const KLISTER_FORE  = new Set(['.', '-', '–', '_', "'"]);
const KLISTER_EFTER = new Set(['.', '-', '–', '_', '/', "'"]);

const ARALNUM = c => !!c && (/\p{L}/u.test(c) || /[0-9]/.test(c));

function vansterFri(text, i) {
  if (i <= 0) return true;
  const f = text[i - 1];
  if (ARALNUM(f)) return false;
  if (ADRESSTECKEN_FORE.has(f)) return false;
  if (KLISTER_FORE.has(f)) return !ARALNUM(text[i - 2]);
  return true;
}

function hogerFri(text, j) {
  if (j >= text.length) return true;
  const e = text[j];
  if (ARALNUM(e)) return false;
  if (ADRESSTECKEN_EFTER.has(e)) return false;
  if (KLISTER_EFTER.has(e)) return !ARALNUM(text[j + 1]);
  return true;
}

/** Står det en enhet direkt efter talet? Då var talet ett mått. */
function enhetEfter(text, j) {
  const m = /^[ \u00A0]?([A-Za-zÅÄÖåäö][A-Za-z/]{0,6})\b/.exec(text.slice(j, j + 12));
  return !!m && EFTERORD.has(m[1].toLowerCase());
}

/*
 * Kandidatmönstret. Tre bokstäver, valfri enkel avskiljare, två siffror och
 * ett sista tecken som får vara siffra eller bokstav (ABC 123 och ABC 12A).
 * Bokstavsklassen är avsiktligt bred (\p{L}, inte A-Z): "väg 250" SKA bli en
 * kandidat och sedan falla på formatgrinden, annars hittar mönstret "äg 250"
 * på fel plats. Mönstret byggs om vid varje anrop — ett delat /g-uttryck bär
 * med sig `lastIndex` mellan anrop, och den buggen är för dyr för att spara
 * en allokering.
 */
const KANDIDAT_KALLA = '(\\p{L}{3})[- \\u00A0\\u2013]?([0-9]{2})([0-9]|\\p{L})';

/**
 * Hittar svenska registreringsnummer i fritext.
 *
 * @param {string} text  Rå text, t.ex. ett chattmeddelande.
 * @param {object} [val]
 * @param {(s: string) => (string|null)} [val.normalisera]
 *        Formatsanningen. Standard är kopian i den här filen; skicka in
 *        plate.js `normaliseraPlat` när den är laddad.
 * @returns {Array<{ratext: string, normaliserat: string, index: number, langd: number}>}
 *        I den ordning numren står i texten, varje distinkt nummer en gång
 *        (den första skrivningen behålls). `ratext` är exakt så som det stod
 *        i texten, `index`/`langd` pekar tillbaka in i den så att träffen går
 *        att markera.
 */
export function hittaRegnummer(text, { normalisera = normaliseraPlatKopia } = {}) {
  if (typeof text !== 'string' || text === '') return [];

  const re = new RegExp(KANDIDAT_KALLA, 'gu');
  const traffar = [];
  const sedda = new Set();
  let m;

  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const slut = start + m[0].length;
    /*
     * Vid ett nej flyttas läshuvudet ett enda steg fram i stället för förbi
     * hela kandidaten. En förkastad kandidat kan innehålla början på en
     * riktig träff ("hus 12ABC 123"), och grindarna gäller ändå för det som
     * hittas där inne — det blir alltså inte lösare, bara mer noggrant.
     */
    const nej = () => { re.lastIndex = start + 1; };

    if (!vansterFri(text, start)) { nej(); continue; }
    if (!hogerFri(text, slut)) { nej(); continue; }

    const bokstaver = m[1].toUpperCase();
    if (ORDGARD.has(bokstaver)) { nej(); continue; }
    if (enhetEfter(text, slut)) { nej(); continue; }

    const kompakt = bokstaver + m[2] + m[3].toUpperCase();
    const plat = normalisera(kompakt);
    /*
     * `plat !== kompakt` är OCR-spärren: normaliseringen fick inte behöva
     * rätta ett enda tecken. Se docblocket överst — utan den blir "BOSTAD"
     * ett fordon.
     */
    if (!plat || plat !== kompakt) { nej(); continue; }

    if (sedda.has(plat)) continue;
    sedda.add(plat);
    traffar.push({ ratext: m[0], normaliserat: plat, index: start, langd: m[0].length });
  }

  return traffar;
}
