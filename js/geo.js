// GPS-spårning: rå position in, fart och kurs man kan lita på ut.
//
// Rörelseberäkningen ligger i harledRorelse(), en ren funktion utan klocka och
// utan GPS. Den går att spela inspelade fixföljder genom rakt av — se
// geo-test.html, som är facit för varje tal som valts här.
//
// Filen äger också GRINDEN för platsfrågan — se avsnittet längre ner. Kort:
// watchPosition är det som i praktiken utlöser webbläsarens platsruta, och
// därför är det här den frågan måste hållas tillbaka tills föraren fått veta
// varför appen ber om den.

// Inget importeras längre ur util.js, och det är avsiktligt.
//
// toKmh avrundar till heltal direkt, och rörelseberäkningen nedan behöver
// rådata i full upplösning ända fram till medianen och rimlighetsspärren —
// annars avrundas små skillnader bort innan de hunnit vägas mot varandra.
//
// distance() och bearing() räknar på storcirkel och ger ett AVSTÅND respektive
// en BÄRING mellan två punkter. Fartberäkningen anpassar numera en linje genom
// många punkter i stället för att subtrahera två, och behöver därför lokala
// meter MED TECKEN, inte belopp. Se tillMeter() längre ner för varför skillnaden
// är avgörande och inte kosmetisk. Resten av appen använder util.js som förr.
import { platsMinne, platsFragad } from './behorigheter.js';

/* ------------------------------------------------------------------ */
/* Grinden: när får platsrutan visas?                                  */
/* ------------------------------------------------------------------ */
//
// Förr anropades watchPosition vid sidladdning, utan fingertryck och innan
// föraren sett en enda rad om varför appen behöver plats. Två saker blev fel:
//
//   • Frågan kom oförklarad, mitt i en app användaren aldrig sett. En förare
//     som inte förstår frågan trycker Neka — och webbläsaren frågar aldrig
//     igen. Ett nej som beror på förvirring är permanent.
//   • På iOS Safari kräver platsrutan i praktiken en levande användargest.
//     Utan gest kan den tystas helt: appen fick varken svar eller position,
//     och ingenting syntes.
//
// Numera håller grinden tillbaka watchPosition vid ALLRA första starten, tills
// js/platsstart.js hunnit förklara varför och låta föraren trycka själv. Har
// appen frågat förr står grinden öppen direkt — då är rutan redan besvarad en
// gång, och att vänta skulle bara försena GPS:en för alla befintliga
// användare.
//
// NÖDUTGÅNG. Om platsstart.js inte laddar, kraschar, eller aldrig får plats på
// skärmen släpps grinden ändå efter NODUTGANG_MS, och appen beter sig som
// förr. En app utan GPS är värdelös, och det får aldrig bero på att en
// dialogruta gick sönder. platsstart.js håller grinden stängd genom att pinga
// hallGrinden() så länge den lever och väntar — slutar pingandet öppnas
// grinden av sig själv.

const NODUTGANG_MS = 25000;

let grind = 'oppen';          // 'oppen' | 'vantar' | 'uppskjuten'
let grindBestamd = false;
let grindOrsak = 'start';
let nodutgangTimer = null;
const vantandeSparare = new Set();

function bestamGrind() {
  if (grindBestamd) return grind;
  grindBestamd = true;

  // Utan DOM finns ingen som kan rita frågan. Då är väntan bara en fördröjning.
  if (typeof window === 'undefined' || typeof document === 'undefined') return grind;

  // Har vi frågat förr — oavsett svar — är det inte längre första starten.
  if (platsMinne() || platsFragad()) { grindOrsak = 'har-fragat-forr'; return grind; }

  grind = 'vantar';
  grindOrsak = 'forsta-starten';
  hallGrinden();
  return grind;
}

/** Vad grinden gör just nu, och varför. */
export function grindLage() {
  bestamGrind();
  return { lage: grind, orsak: grindOrsak, vantande: vantandeSparare.size };
}

/**
 * Håll grinden stängd en stund till. platsstart.js pingar den medan den lever
 * och väntar på ledig skärm; tystnar pingen träder nödutgången in.
 */
export function hallGrinden(ms = NODUTGANG_MS) {
  if (grind !== 'vantar') return;
  clearTimeout(nodutgangTimer);
  nodutgangTimer = setTimeout(() => slappFramPlats('nodutgang'), ms);
}

/** Föraren har svarat, eller vi behöver inte fråga. Släpp fram GPS:en. */
export function slappFramPlats(orsak = 'ok') {
  grindBestamd = true;
  grind = 'oppen';
  grindOrsak = orsak;
  clearTimeout(nodutgangTimer);
  nodutgangTimer = null;
  for (const t of [...vantandeSparare]) {
    vantandeSparare.delete(t);
    t.start();
  }
}

/**
 * Föraren sa "inte nu".
 *
 * Ingen nödutgång här: att öppna grinden bakvägen tjugofem sekunder efter ett
 * "inte nu" hade gett exakt den oförklarade systemruta som hela grinden finns
 * för att undvika, och dessutom fått appen att framstå som att den inte
 * lyssnar. Grinden öppnas nu bara av ett nytt tryck.
 */
export function skjutUppPlats(orsak = 'inte-nu') {
  bestamGrind();
  if (grind === 'oppen') return false;
  grind = 'uppskjuten';
  grindOrsak = orsak;
  clearTimeout(nodutgangTimer);
  nodutgangTimer = null;
  return true;
}

/* ------------------------------------------------------------------ */
/* Rörelse: fart, kurs och "rullar bilen?"                             */
/* ------------------------------------------------------------------ */
//
// BAKGRUNDEN, så att ingen råkar bygga tillbaka felet.
//
// Den ALLRA första härledningen tog farten ur avståndet mellan två fixar som
// låg minst 15 METER isär, och läste aldrig coords.accuracy. GPS-brus när man
// står still eller går ligger rutinmässigt på 20–40 meter, alltså MER än
// tröskeln. Två brusiga fixar 15 m isär med två sekunder emellan blev 27 km/h.
// Ägaren rapporterade 26 km/h medan han promenerade — exakt den siffran.
//
// Värre än så: loopen letade BAKÅT och tog den SENASTE punkt som råkade ligga
// 15 m bort. När den verkliga förflyttningen är noll är de enda punkter som når
// 15 m just de brusigaste, och de ligger närmast i tiden. Urvalet plockade
// alltså systematiskt fram maximalt brus delat med kortast möjliga tid. Det var
// inte bara en för låg tröskel, det var ett partiskt urval.
//
// FÖRSTA LAGNINGEN gjorde tröskeln beroende av accuracy och lät baslinjen
// eskalera bakåt tills kravet slogs. Den dog av tre skäl, alla mätta:
//
//   • ETT PAR ÄR ETT PAR. Två punkter kan aldrig skilja rörelse från brus,
//     hur hög tröskeln än sätts. Sätts den lågt släpps bruset igenom; sätts
//     den högt tystnar bilen. Vid accuracy 40 krävdes ~37 km/h innan någon
//     siffra alls kom fram — en bil i 30 var helt tyst.
//   • ESKALERINGEN GAV BRUSET MÅNGA FÖRSÖK. Ett dussin baslinjer per fix,
//     första träffen vann. Ett par som ligger isär av ren slump i en procent
//     av fallen träffar då inom minuter. Och en enda utrusare i historiken
//     låg kvar som referenspunkt i hela eskaleringsfönstret och gav träff
//     efter träff.
//   • DET FANNS INGEN VÄG TILLBAKA. Utan doppler kunde ingenting någonsin
//     visa att bilen stod still, så ett fantomvärde blev permanent.
//
// SÅ HÄR RÄKNAS FARTEN NU, i den ordning försvaren verkar:
//
//   1. Dopplerfarten först. coords.speed mäts på bärvågens frekvensskift, inte
//      på skillnaden mellan två positioner. Den är storleksordningar bättre vid
//      låg fart och bryr sig inte om att positionen hoppar.
//   2. Saknas doppler ANPASSAS en rät linje genom positionerna i ett fönster,
//      i stället för att två punkter subtraheras. Lutningen är farten. Ett
//      fönster med N fixar dämpar bruset ungefär som √N och, viktigare, som
//      1/fönsterlängd — det är den enda mekanism som ger både tyst brus OCH
//      hörd bil, vilket inget par av punkter kan.
//   3. Anpassningen är ROBUST (Theil–Sen: medianen av alla parvisa lutningar).
//      En enstaka utrusare flyttar en median inte alls, medan den drar en
//      minstakvadratlinje efter sig. Utrusare är precis den form felet har.
//   4. Lutningen jämförs med SIN EGEN osäkerhet. Anpassningen ger inte bara
//      en fart utan också ett σ som följer av fixarnas accuracy och fönstrets
//      längd. Farten tros på först när den är signifikant. Det ersätter varje
//      fast meter- och km/h-gräns med en som räknas om för varje fönster.
//   5. Fönstret VÄXER bara när det behövs: kortast först, längre bara när det
//      korta inte räckte. Ett kort fönster följer kurvor och accelerationer;
//      ett långt behövs bara vid låg fart eller dålig signal, där kurvfelet
//      ändå är minst.
//   6. Median över tre avläsningar plus en rimlighetsspärr på accelerationen,
//      som backstopp.
//
// OCH — det som saknades helt förut — anpassningen kan BEVISA STILLASTÅENDE.
// Är fönstrets övre konfidensgräns lägre än körtröskeln vet vi att bilen inte
// kör, även om vi inte vet exakt hur långsamt den går. Det är en trovärdig
// avläsning i sin egen rätt, den nollar den hållna farten och den driver
// hysteresen som släcker moving. Utan den kunde bara dopplern någonsin ta
// appen ur körläge, och en telefon utan doppler fastnade i "kör" för alltid.
//
// ÅT VILKET HÅLL FILTRET LUTAR, OCH HUR VI VET DET.
//
// En utebliven polisvarning är värre än en felaktig hastighetssiffra. Alla
// tystnadsgrindar i appen är skrivna `fix.speedKmh ?? 0` — okänd fart tolkas
// alltså som STILLASTÅENDE, och stillastående betyder tystnad: polisvarningen
// kräver 5 km/h, kameravarningen 15, ruttvakten 15, vakthunden 15, vintern 20.
// Att returnera null "för säkerhets skull" hade därför tystat hela appen precis
// när GPS:en är svag — i tunnlar, under viadukter och mellan höghus, alltså på
// samma platser där kontroller och kameror sitter tätast.
//
// Därför gäller genomgående: när vi inte VET, gissar vi åt körhållet.
//
//   • Vi returnerar aldrig null efter att vi en gång haft en trovärdig
//     avläsning. Tappar vi trovärdigheten håller vi kvar det senast kända
//     värdet i stället, oförändrat. Fältet fartFarsk berättar att värdet är
//     hållet, för den som vill veta.
//   • Men hållandet är inte oändligt, och skillnaden mot förr sitter i VARFÖR
//     vi tystnade. Kommer inga fixar, eller bara obrukbara (tunnel, garage,
//     mastgissning), håller vi kvar hur länge som helst — då vet vi ingenting
//     och får inte gissa att bilen stannat. Kommer det däremot ANVÄNDBARA
//     fixar utan att någon av dem säger något om farten, är det i sig
//     information: se hallMaxMs. I praktiken hinner stillhetsbeviset i punkt
//     "OCH" ovan nästan alltid före den spärren; den finns för hörnen där
//     fixarna är både glesa och skräpiga.
//   • Noggrannhetsgrinden är medvetet SLAPPARE än appens två befintliga
//     (chatt.js 50 m, kartrotation.js 60 m). De två avgör om ett textfält ska
//     låsas och om kartan ska rotera; den här avgör om appen får varna för
//     polis. Det är inte samma sak, och den ska inte ha samma stränghet.
//   • Rimlighetsspärren bromsar bara UPPÅT. En krock stannar bilen på en
//     bråkdel av en sekund, och den händelsen får inte jämnas bort.
//   • moving är lättare att slå på än att slå av, och slås aldrig av av
//     tystnad — bara av trovärdiga låga avläsningar i följd.

/**
 * Timeout för watchPosition, ms.
 *
 * Talet ligger som konstant och inte inbakat i optionsobjektet därför att det
 * en gång drev isär från fartberäkningen: här stod 20000 medan
 * referenspunkter äldre än 15000 ms kastades längre ner. Ett fixintervall på
 * 16–20 s var alltså helt normalt för spåraren men omöjligt för
 * fartberäkningen, som då gav 0 km/h i hundra procent av tiden.
 *
 * Kopplingen är numera bruten på ett bättre sätt än genom att göra talen lika:
 * fartberäkningen har ingen övre gräns alls på hur gamla fixar den får para
 * ihop, bara historikfönstret (historikFonsterMs, en minut). En enhet som
 * levererar en fix var trettionde sekund fungerar därför också, trots att den
 * ligger utanför den här timeouten. Konstanten står kvar som en påminnelse om
 * var felet satt, och för att den som ändrar 20000 ska läsa det här först.
 */
export const GPS_TIMEOUT_MS = 20000;

export const RORELSE = {
  /**
   * Högsta fart vi tror på över huvud taget, km/h.
   *
   * Över det här är det ett chipfel eller en beräkning på skräpdata, inte en
   * bil. 400 är valt med stor marginal med flit: snabbaste rimliga vägfart är
   * kring 250–300 på tysk autobahn, och taket ska aldrig kunna kapa en
   * verklig avläsning. Det är en spärr mot orimligheter, inte ett filter.
   */
  maxTrovardigKmh: 400,

  /**
   * Samma spärr, men för fart som räknats ur POSITIONER, km/h.
   *
   * 400 är rätt för doppler: chippet kan mäta så snabbt, och siffran är då
   * antingen sann eller uppenbart trasig. En positionsanpassning är något
   * annat — där är ett fyrsiffrigt värde alltid ett brusutslag, aldrig en
   * mätning. 200 km/h kapar ingen verklig svensk körning (högsta tillåtna är
   * 120, och även en grov fortkörning ligger långt under 200) men tar bort de
   * värsta utslagen innan de hinner ut i medianen och accelerationsspärren.
   */
  maxSkillnadKmh: 200,

  /**
   * Sämsta noggrannhet (meter) en fix får ha och ändå driva en
   * SKILLNADSBERÄKNAD fart.
   *
   * Gäller inte dopplerfarten. Doppler kommer från GNSS-chippet och mäter
   * frekvens, inte position; en dålig positionsnoggrannhet gör den inte fel.
   * Att kasta bra dopplerdata för att positionen är osäker vore att slänga
   * det enda vi faktiskt kan lita på. Grinden sitter alltså där felet finns.
   *
   * 75 meter, inte 50 som chatt.js eller 60 som kartrotation.js. De två
   * besluten är restriktiva — de låser ett textfält och roterar en karta, och
   * att fela åt det försiktiga hållet kostar bara bekvämlighet. Det här
   * beslutet är tvärtom: felar vi åt det försiktiga hållet tystnar
   * polisvarningen. Under en viadukt eller i en stadsgata ligger accuracy ofta
   * på 40–70 m mitt under verklig körning, och de fixarna måste få räknas.
   * Över 75 m är vi i inomhus- och mastgissningsland, där ingen
   * positionsskillnad betyder något.
   */
  maxOsakerhetM: 75,

  /**
   * Hur många gånger accuracy man ska dela med för att få ETT sigma, per axel.
   *
   * accuracy är enligt W3C-specifikationen en 95-procentsradie, alltså ungefär
   * två sigma. Android dokumenterar i stället sin Location.getAccuracy() som en
   * 68-procentsradie, alltså ett sigma, och iOS säger ingenting alls. Att tro
   * på specifikationen (dela med 2) hade underskattat bruset på den plattform
   * som faktiskt har flest användare.
   *
   * 1,5 är mitten av de två definitionerna, och riktningen är medvetet vald:
   * ett för STORT sigma gör anpassningen försiktig och tystar appen, ett för
   * litet släpper igenom brus. Mitten träffar Androids verkliga beteende
   * ungefär rätt och är samtidigt inte så pessimistisk som specifikationens
   * bokstav — den enda tolkning som hade kostat polisvarningar.
   */
  osakerhetTillSigma: 1.5,

  /**
   * Golv för sigma, meter.
   *
   * Ett chip som påstår accuracy 1 m ger annars sigma 0,67 m, och då blir varje
   * darrning i kartprojektionen "signifikant". Golvet är också det som räddar
   * fixar HELT UTAN accuracy: förr räknades saknad accuracy som noll, vilket i
   * praktiken var ett påstående om perfekt mätning. Fem meter är ungefär vad en
   * bra GNSS-fix under öppen himmel faktiskt klarar; bättre än så existerar inte
   * utan RTK.
   */
  osakerhetGolvM: 5,

  /**
   * Kortaste anpassningsfönstret, ms — och steget i trappan nedanför.
   *
   * Fyra sekunder är valt som en avvägning: vid 70 km/h ger det 78 meters
   * baslinje, och sekanten genom en normal vägkurva är då bara någon procent
   * kortare än vägen. Längre fönster underskattar farten i rondeller och
   * avfarter, och underskattad fart krymper kameravarningens förvarningsavstånd
   * (det räknas som fart × 25 s).
   */
  refFonsterMs: 4000,

  /**
   * Trappan av fönsterlängder, i multiplar av refFonsterMs.
   *
   * 4, 8, 16, 32 och 60 sekunder. Kortast prövas först och den FÖRSTA
   * signifikanta vinner, av två skäl: ett kort fönster följer kurvor och
   * accelerationer, och ett kort fönster som redan är signifikant har per
   * definition en stark signal och behöver ingen utjämning.
   *
   * Varför en gles trappa och inte varje möjlig längd: varje prövning är en
   * chans till falskt utslag. Den gamla eskaleringen provade ett dussin
   * baslinjer per fix och gav bruset ett dussin gratisförsök. Fem prövningar
   * med en riktig signifikansgräns bakom sig är en helt annan sak än tolv
   * prövningar mot en fast metergräns — och trappan är geometrisk just för att
   * fem steg ska räcka hela vägen från fyra till sextio sekunder.
   *
   * Varför den behövs åt andra hållet: en bil i 30 km/h med accuracy 40 och
   * ingen doppler ger ingen signifikant lutning på fyra sekunder men en tydlig
   * på sexton. Utan trappan hade den bilen varit helt tyst — och en utebliven
   * polisvarning är det dyraste felet den här filen kan göra.
   */
  passaTrappa: [1, 2, 4, 8, 15],

  /**
   * Högsta antal punkter en anpassning använder.
   *
   * Theil–Sen går över alla par, alltså O(n²). Sextio fixar i ett fönster (en
   * minut vid 1 Hz, tolv sekunder vid 5 Hz) ger 1770 par per axel och fönster,
   * gånger fem fönster gånger tre kandidater — det är för mycket att göra en
   * gång per fix på en telefon som samtidigt ritar karta. Fler punkter än så
   * glesas ut jämnt över fönstret, vilket bevarar fönstrets LÄNGD, och det är
   * längden som dominerar precisionen: sigma för lutningen går som 1/längd men
   * bara som 1/√antal.
   */
  passaMaxPunkter: 24,

  /**
   * Påslag på anpassningens sigma.
   *
   * Theil–Sen betalar för sin robusthet med ungefär tio procent sämre precision
   * än minstakvadratmetoden när bruset ändå är normalfördelat. Formeln nedan är
   * minstakvadratmetodens; påslaget gör den ärlig. Utjämningen är dessutom
   * grovt räknad med ETT sigma för hela fönstret (medelvärdet av fixarnas), så
   * ett litet påslag åt det försiktiga hållet är rimligt.
   */
  passaInflation: 1.1,

  /**
   * Minsta tid mellan referens och nyaste fix, ms.
   *
   * watchPosition körs med maximumAge 1000, så två "olika" fixar kan bära
   * nästan samma tidsstämpel. Delar man en förflyttning med en tiondels sekund
   * blir vad som helst hundra km/h. 900 och inte 1000 därför att en enhet som
   * siktar på 1 Hz i praktiken landar på 950–1050 ms, och vi vill inte råka
   * kasta varannan fix på en tiondels marginal.
   */
  minDtMs: 900,

  /**
   * Hur många sigma lutningen måste vara för att vi ska tro på den.
   *
   * Det här är den gräns som ERSÄTTER hela den gamla meterberäkningen
   * (minForflyttningM, osakerhetsMarginal, kravdForflyttning). Skillnaden är
   * inte kosmetisk: metergränsen var samma tal oavsett hur många fixar och hur
   * lång tid beräkningen hade på sig, medan sigma räknas om för varje fönster
   * och därför skärps automatiskt när underlaget är tunt och släpper när det är
   * gott. Det är den enda formuleringen jag hittat som samtidigt kan vara tyst
   * mot en telefon på ett bord och hörd i en bil med accuracy 40.
   *
   * Farten är ett tvådimensionellt belopp, så nollfördelningen är Rayleigh:
   * risken att rent brus ger mer än k sigma är exp(−k²/2). Vid 4 är det 0,03
   * procent per fix — och utslaget ligger då precis vid gränsen, alltså lågt,
   * eftersom gränsen är k gånger fönstrets egen brusnivå. Ett brusutslag kan
   * alltså inte längre bli 77 km/h.
   *
   * Fyra och inte 3,5: mätt på gaussiskt brus (sigma 0,55 × accuracy, alltså
   * verkligt GPS-brus och inte den bundna ring geo-test.html använder) halverar
   * steget från 3,5 till 4 andelen promenader som felaktigt får moving = true,
   * från 36 till 18 procent, UTAN att kosta något mätbart åt andra hållet: 30
   * km/h med accuracy 40, 70 km/h med accuracy 70 och tiden till första
   * avläsning vid igångkörning var identiska i båda fallen.
   *
   * Varför inte högre: varje extra sigma är också en bil som inte hörs, och
   * över 4 slutade siffrorna förbättras — 4,5 var mätbart sämre på gång-
   * falsklarmen och 1 sekund långsammare vid igångkörning.
   */
  signifikansK: 4,

  /**
   * Hur många sigma STILLHETSBEVISET räknar med.
   *
   * Skilt från signifikansK därför att frågorna är olika. signifikansK avgör om
   * vi vågar PÅSTÅ en fart, och där kostar ett falskt ja ett falskt körläge.
   * Här avgör vi i stället om ett helt konfidensintervall ryms under
   * körtröskeln, och där kostar ett falskt nej att appen aldrig kommer ur
   * körläget — vilket var precis felet i förra versionen.
   *
   * Tre sigma är 99,9 procent åt ett håll och räcker gott för att säga "det här
   * är inte en bil i rörelse". Hade talet följt signifikansK upp till 4 hade
   * stillhetsbeviset slutat fungera vid sämsta tillåtna accuracy (75 m), och då
   * hade den enda vägen ur körläget varit hallMaxMs två minuter senare.
   */
  stillaK: 3,

  /**
   * Samma gräns, men när fönstret bara innehåller TVÅ punkter.
   *
   * Två punkter är den gamla, trasiga geometrin: ingen robusthet alls, ingen
   * utjämning, och en enda utrusare är hela mätningen. Grenen finns bara kvar
   * för enheter som levererar en fix var tjugonde sekund, där två punkter är
   * allt som finns — och där baslinjen i gengäld är så lång att en verklig fart
   * ligger många sigma över gränsen ändå.
   *
   * 5,5 sigma är 0,0000015 i falsklarmsrisk. Räknat på ägarens fall — accuracy
   * 30, fyra sekunder, två punkter — blir gränsen omkring 130 km/h. Det var
   * precis den beräkningen som gav 26 km/h, och den kan nu aldrig mer synas.
   * Räknat på det glesa fallet — accuracy 15, sexton sekunder mellan fixarna —
   * blir gränsen omkring 17 km/h, alltså långt under en motorvägsfart.
   */
  signifikansKPar: 5.5,

  /**
   * Hur mycket av farten nästa LÄNGRE fönster måste bekräfta.
   *
   * Se resonemanget i passaGren. Kort: signifikans ensam räcker inte, för en
   * fluktuation kan vara signifikant i sitt eget fönster. Verklig fart syns
   * fortfarande när man tittar dubbelt så långt bak.
   *
   * 0,4 och inte 0,5, trots att trappan fördubblas. En bil som startade i
   * exakt samma ögonblick som det korta fönstret började ger halva farten i
   * det dubbelt så långa; hade kravet varit precis 0,5 hade den legat på
   * gränsen och tappats av minsta brus. 0,4 ger den marginalen och kostar nära
   * ingenting mot bruset, som typiskt ger under 0,3.
   */
  stodFaktor: 0.4,

  /**
   * När en positionsanpassning får gå FÖRE dopplern.
   *
   * Dopplern vinner normalt, av skälen längre upp. Men ett chip kan rapportera
   * en fastnad nolla eller ett kraftigt eftersläpande värde medan positionen
   * bevisligen flyttar sig, och då valde den gamla koden systematiskt det LÄGRE
   * av två värden — rakt emot lutningen hela filen annars har. Mätt: doppler 0
   * i 90 km/h gav 0 km/h och moving = false hela vägen, alltså tyst polis- och
   * kameravarning.
   *
   * Korskontrollen slår till bara när anpassningen är signifikant OCH säger
   * minst 15 km/h OCH minst tre gånger dopplern. Tre gånger, inte 1,5: en
   * doppler som ligger något efter i en acceleration ska inte kastas, det är
   * normalt och självrättande. En doppler som säger 5 medan positionen säger 90
   * är däremot trasig. Femton km/h-golvet gör att krypfart och parkerings-
   * manövrar aldrig kan trigga kontrollen.
   */
  dopplerKorsMinKmh: 15,
  dopplerKorsFaktor: 3,

  /**
   * Största acceleration vi tror på, m/s².
   *
   * ENKELRIKTAD: spärren bromsar bara ökningar. En bil som krockar går från 90
   * till 0 på bråkdelen av en sekund, och den händelsen får inte filtreras bort
   * — därför finns ingen motsvarande spärr nedåt.
   *
   * Åtta m/s² motsvarar 0–100 km/h på 3,5 sekunder. Ingen bil på svensk väg
   * accelererar snabbare, så spärren kan aldrig kapa en verklig igångkörning.
   * Den är alltså ett skydd mot orimligheter (ett hopp till 108 km/h), inte
   * mot det brus ägaren såg: 26 km/h på en sekund är 7,2 m/s² och slipper
   * igenom. Det bruset stoppas av signifikansgränsen ovanför, inte här.
   *
   * Spärren skalar med tiden sedan förra avläsningen, så ett signalbortfall på
   * en halv minut släpper igenom vilken fart som helst efteråt. Den ska inte
   * kunna hålla kvar en nolla när bilen kommer ut ur en tunnel i nittio.
   *
   * DEN FÖRSTA avläsningen efter en kallstart är med FLIT oklampad. Frestelsen
   * är att klampa den mot noll, men noll är inte en mätning — det är vad vi
   * skriver ut när vi ingenting vet. Klampar man mot den blir taket 29 km/h på
   * första sekunden, och en förare som öppnar appen i nittio på E18 får då
   * varken kamera- eller polisvarning under de första sekunderna. Det som
   * skyddar den första avläsningen är i stället signifikansgränsen: en lutning
   * som klarar 3,5 sigma över ett helt fönster är ingen enstaka utrusare.
   */
  maxAccelMs2: 8,

  /**
   * Hur många avläsningar medianen går över, och hur gamla de får vara.
   *
   * MEDIAN, inte medelvärde. Ett medelvärde flyttas av varje utrusare i
   * proportion till hur galen den är: ett brusvärde på 100 km/h bland två
   * nollor ger 33 km/h och tänder allt i appen. Medianen av samma tre tal är 0
   * — en enstaka utrusare försvinner helt, oavsett hur stor den är. Det är
   * precis den formen felet har här: enstaka hopp i en i övrigt lugn följd.
   *
   * TRE, inte fem. Medianen av tre ligger exakt en avläsning efter en verklig
   * stigning; medianen av fem ligger två efter. Vid 1 Hz är det skillnaden
   * mellan en och två sekunders eftersläpning när bilen rullar igång från
   * rödljus — och det är just de sekunderna man passerar patrullen i
   * infarten. En sekund är priset vi betalar för att slippa falsklarm som
   * dessutom spärrar en riktig varning i åtta minuter (alerts.js). Två
   * sekunder är det inte värt.
   *
   * Dopplergrenen har dessutom en genväg förbi eftersläpningen, se nedan.
   *
   * MEDIANEN ÄR INTE LÄNGRE HUVUDFÖRSVARET, och det är en viktig skillnad mot
   * förr. Granskningen visade varför: när telefonen står still gav bara någon
   * enstaka procent av fixarna en avläsning alls, så tre stycken inom fem
   * sekunder fanns nästan aldrig — och koden föll då tillbaka på det RÅA
   * utslaget, precis det medianen byggdes för att döda. Utjämningen sitter nu i
   * anpassningen i stället, där den alltid finns: varje avläsning är redan
   * medianen av alla parvisa lutningar i sitt fönster. Medianen här är ett
   * andra lager, inte det enda.
   *
   * Att fönstret är fem sekunder gör att en enhet med glesa fixar bara får en
   * kandidat och alltså ingen utjämning. Det är avsiktligt: den enheten har
   * redan en lång baslinje i sin anpassning, och att vänta in tre avläsningar
   * hade betytt en minuts eftersläpning.
   */
  medianAntal: 3,
  medianFonsterMs: 5000,

  /**
   * Hysteres för fix.moving: lättare att bli "kör" än att sluta vara det.
   *
   * PÅ vid 8 km/h, direkt, på en enda trovärdig avläsning. Åtta är samma tal
   * som förr och samma tal som chatt.js GRANSER.farttroskelKmh, som uttryckligen
   * skriver att den följer geo.js. Att flytta det här hade tyst drivit isär två
   * kopior av samma gräns — projektet har redan lärt sig vad det kostar av
   * nykterhetsregelns sex kopior. Talet får därför stå, och den som ändrar det
   * ska ändra chatt.js i samma andetag.
   *
   * AV först under 4 km/h, och först efter tolv sekunder i följd.
   *
   * Varför 4: hälften av påslagsgränsen ger ett hysteresband på 4–8 km/h som är
   * bredare än den jitter dopplern har vid krypfart. Utan bandet hade flaggan
   * fladdrat fram och tillbaka i en kö, och rutt.js — den enda läsaren — hade
   * omväxlande vägrat och tillåtit att en ruttavvikelse deklareras.
   *
   * Varför tolv sekunder: långt nog att överleva en väjning, en gupp och ett
   * stopp i en korsning, kort nog att en parkerad bil släcker körläget medan
   * föraren fortfarande sitter kvar. Räknaren drivs BARA av trovärdiga
   * avläsningar under 4 km/h. Tystnad räknas inte — en tunnel eller ett
   * signaltapp kan alltså aldrig slå av körläget mitt i en körning, hur länge
   * det än varar. Det var kravet, och det är så det uppfylls.
   *
   * Det som ÄNDRATS är vad som räknas som en trovärdig låg avläsning. Förr
   * krävdes att telefonen bevisade en förflyttning under 4 km/h, och en
   * parkerad bil förflyttar sig noll meter — den kunde alltså aldrig bevisa
   * något, och utan doppler fastnade appen i körläge för alltid. Nu räknas
   * också ett STILLHETSBEVIS: ett fönster vars övre konfidensgräns ligger under
   * körtröskeln. Att inte ha rört sig är därmed lika mätbart som att ha gjort
   * det, vilket det alltid borde ha varit.
   */
  borjaKoraKmh: 8,
  slutaKoraKmh: 4,
  slutaKoraMs: 12000,

  /**
   * Hur länge moving får överleva på avläsningar som ALDRIG når körtröskeln, ms.
   *
   * Hysteresbandet 4–8 km/h var tänkt som ett skydd mot fladder i kö, men det
   * hade en baksida ingen räknat med: en avläsning i bandet varken tänder eller
   * släcker flaggan, så en följd som ligger kvar i bandet håller körläget uppe
   * i all evighet. Mätt: en person som GÅR i 5 km/h och en enda gång råkar få
   * ett brusutslag över 8 km/h behåller moving = true i fem minuter, eftersom
   * hans verkliga 5 km/h sedan hamnar mitt i bandet och tolvsekundersräknaren
   * (som kräver under 4) aldrig ens startar.
   *
   * Nittio sekunder utan att en enda avläsning nått över 8 km/h betyder att man
   * inte kört på halvannan minut. En kö som kryper i 5–7 km/h får alltså moving
   * = false efter nittio sekunder, och det är en medveten kostnad: rutt.js
   * pausar då omräkningen av rutten, vilket självrättas i samma sekund som
   * bilen passerar 8 km/h igen. Priset för motsatsen — att lita på flaggan i en
   * app som tror att en fotgängare kör bil — är högre.
   *
   * Nittio och inte trettio: geo-test.html kräver noll flaggbyten under trettio
   * sekunders krypfart, och det kravet är riktigt. Nittio ligger med god
   * marginal utanför både det och ett normalt rödljus.
   */
  bandMaxMs: 90000,

  /**
   * Hur många sigma marginal moving kräver ner till körtröskeln.
   *
   * Se hysteresen längst ner i harledRorelse. Kort: farten som VISAS är bästa
   * gissningen, men flaggan som säger "bilen rullar" ska bära sin egen
   * osäkerhet, annars blir varje fotgängare med brusig GPS en bilist.
   *
   * Två, och det är mätt och inte gissat. Över gaussiskt brus (sigma 0,55 ×
   * accuracy) med en gående i 5 km/h och accuracy 25–35:
   *
   *   utan kravet   16 procent av promenaderna fick körläge, längst 217 s
   *   movingK 1,5    2 procent, längst 98 s
   *   movingK 2      0 procent
   *
   * Och åt andra hållet, andel av tiden med moving = true under VERKLIG körning
   * utan doppler, 30 slumpade förlopp per ruta:
   *
   *   fart/accuracy  12/30  15/40  20/40  30/40  20/60
   *   movingK 2       100%   100%   100%   100%   100%
   *   movingK 3        93%   100%   100%   100%   100%
   *
   * Två kostar alltså ingenting alls på verklig körning men tar bort
   * gångfallet helt, medan tre börjar knapra på krypfarten. Enda rutan som inte
   * är hundra vid två är 9 km/h med accuracy 25 (67 procent) — en fart som
   * ligger ett enda km/h över tröskeln och som ingen mätning på jorden kan
   * skilja från en joggare med den noggrannheten. Farten som VISAS är ändå
   * korrekt där, så polis- och kameragrindarna påverkas inte.
   */
  movingK: 2,

  /**
   * Hur långt bak historiken sträcker sig, ms — och ett rent minnestak.
   *
   * TID, inte antal. Det gamla taket var tolv FIXAR, vilket vid 1 Hz spänner
   * elva sekunder och vid 5 Hz bara två. Det gjorde två saker samtidigt: den
   * dokumenterade eskaleringen till femton sekunder kunde aldrig nås, och hela
   * beräkningen bytte beteende med enhetens fixtakt utan att någon konstant sa
   * det. Mätt på den gamla koden: en bil i 30 km/h med accuracy 40 och utan
   * doppler gav 0 km/h i hundra procent av tiden, enbart på grund av taket.
   *
   * Sextio sekunder är valt av trappan ovanför: längsta fönstret är
   * refFonsterMs × 15 = 60 s, och historiken ska rymma exakt det längsta
   * fönster någon får be om, varken mer eller mindre. Ändras trappan ska det
   * här talet följa med.
   *
   * historikTak är bara ett minnestak, inte en tidsgräns. 300 räcker för 5 Hz i
   * en hel minut; en enhet som skickar tätare tappar de äldsta fixarna, vilket
   * bara glesar underlaget och aldrig kortar fönstret.
   */
  historikFonsterMs: 60000,
  historikTak: 300,

  /**
   * Hur länge en HÅLLEN fart får leva när fixarna faktiskt kommer in, ms.
   *
   * Skilj på två sorters tystnad. Kommer inga fixar, eller bara obrukbara
   * (tunnel, garage, accuracy 900), vet vi ingenting och håller kvar farten hur
   * länge som helst — det är själva poängen med hållandet, och det ändras inte.
   *
   * Men kommer det ANVÄNDBARA fixar, i två minuter, utan att en enda av dem
   * säger något om farten, då är hållandet inte längre "vi tappade signalen"
   * utan "vi vägrar ompröva". Mätt på förra versionen: en bil som parkerade
   * visade fortfarande 25 km/h och moving = true efter tio minuter på
   * parkeringen, vilket fick driving.js att registrera en körning som aldrig
   * skedde och alerts.js att räkna förvarningsavstånd åt en stillastående bil.
   *
   * Två minuter, inte tjugo sekunder, och det är medvetet trögt: spärren ska
   * vara det sista som räddar, inte det första. I praktiken hinner
   * stillhetsbeviset före den nästan alltid — en minutlång anpassning binder
   * farten under 8 km/h även vid sämsta tillåtna accuracy. Och skulle bilen
   * ändå köra: två minuters körning i vilken fart som helst ger en lutning som
   * ligger många sigma över gränsen i minutfönstret, så spärren kan inte tysta
   * en bil som rullar.
   */
  hallMaxMs: 120000,
};

/** Rå m/s från chippet till en km/h vi vågar tro på, annars null. */
function dopplerKmh(ms, g) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const kmh = ms * 3.6;
  if (kmh > g.maxTrovardigKmh) return null;
  return kmh;
}

/* Meter per grad latitud. Longituden krymper med cos(lat). */
const M_PER_GRAD = 111320;

/**
 * Fixarna till lokala meter kring en referenspunkt.
 *
 * Varför inte util.js distance(): den ger ett AVSTÅND, alltså ett belopp utan
 * tecken, och en anpassning behöver komposanter som kan vara negativa. Ett
 * belopp kan bara växa, och just det var en av mekanismerna bakom fantomfarten
 * — brus åt vilket håll som helst lade sig ovanpå sträckan. Med tecken tar
 * bruset ut sig själv över flera fixar i stället för att ackumuleras.
 *
 * Plan projektion, inte storcirkel: fönstren är som mest någon kilometer långa,
 * och på den skalan är felet under en promille. util.js används fortfarande
 * överallt där riktiga avstånd räknas.
 */
function tillMeter(f, ref, kosLat, g) {
  // Saknas accuracy antas den vara medelmåttig i stället för perfekt. Den
  // gamla koden räknade saknad accuracy som NOLL, vilket är ett påstående om
  // felfri mätning — den slappaste möjliga tolkningen av att inte veta.
  const acc = Number.isFinite(f.accuracy) ? f.accuracy : g.maxOsakerhetM / 2;
  return {
    x: (f.lon - ref.lon) * M_PER_GRAD * kosLat,
    y: (f.lat - ref.lat) * M_PER_GRAD,
    t: f.ts / 1000,
    sigma: Math.max(g.osakerhetGolvM, acc / g.osakerhetTillSigma),
  };
}

/** Mittvärdet. Vid jämnt antal det lägre av de två mittersta. */
function median(tal) {
  const s = [...tal].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

/**
 * Anpassa en hastighet till en punktföljd, robust, med osäkerhet.
 *
 * THEIL–SEN, alltså medianen av alla parvisa lutningar, en gång per axel.
 * Varför inte minsta kvadrat: en enda utrusare drar en minstakvadratlinje efter
 * sig i proportion till hur galen den är, och utrusare är precis den form GPS-
 * felet har (en fix som mastgissar, en reflexion i en husvägg). Theil–Sen tål
 * att nästan en tredjedel av punkterna är skräp utan att svaret rör sig.
 *
 * Bara par med minst minDtMs emellan används. Två fixar med samma tidsstämpel
 * ger en oändlig lutning, och två fixar en tiondels sekund isär ger vad som
 * helst gånger tio.
 *
 * OSÄKERHETEN är minstakvadratmetodens standardfel för en lutning,
 *   sigma_v = sigma_pos / sqrt(Σ(t − t̄)²),
 * med ett påslag för att Theil–Sen är något mindre effektiv (passaInflation).
 * Nämnaren är det viktiga: den växer med både antalet punkter OCH fönstrets
 * längd, och det är därför den här formuleringen kan vara tyst mot en telefon
 * på ett bord utan att bli döv mot en bil. En parvis subtraktion har ingen
 * sådan nämnare — den har bara två punkter, alltid.
 *
 * @returns {{kmh:number, kurs:number|null, sigmaKmh:number, n:number}|null}
 */
function passa(fixar, g) {
  if (!Array.isArray(fixar) || fixar.length < 2) return null;

  const ref = fixar[fixar.length - 1];
  const kosLat = Math.cos(ref.lat * Math.PI / 180);
  const p = fixar.map(f => tillMeter(f, ref, kosLat, g));
  const minDt = g.minDtMs / 1000;

  const lutX = [];
  const lutY = [];
  for (let a = 0; a < p.length - 1; a++) {
    for (let b = a + 1; b < p.length; b++) {
      const dt = p[b].t - p[a].t;
      if (dt < minDt) continue;
      lutX.push((p[b].x - p[a].x) / dt);
      lutY.push((p[b].y - p[a].y) / dt);
    }
  }
  if (!lutX.length) return null;

  const vx = median(lutX);
  const vy = median(lutY);
  const fart = Math.hypot(vx, vy);
  if (!Number.isFinite(fart)) return null;

  // Σ(t − t̄)² i sekunder². Nämnaren i standardfelet.
  const tm = p.reduce((s, q) => s + q.t, 0) / p.length;
  const spridning = p.reduce((s, q) => s + (q.t - tm) ** 2, 0);
  if (!(spridning > 0)) return null;

  // Ett sigma för hela fönstret: medelvärdet av fixarnas. Grovt, men det är
  // därför passaInflation finns. Att i stället vikta varje punkt hade gett
  // några procent bättre precision och en betydligt svårare funktion att läsa.
  const sigmaPos = p.reduce((s, q) => s + q.sigma, 0) / p.length;
  const sigma = g.passaInflation * sigmaPos / Math.sqrt(spridning);

  return {
    kmh: fart * 3.6,
    // Kursen är bara meningsfull när lutningen är det. Anroparen avgör; här
    // räknas den bara ut. atan2(x, y) och inte (y, x): kompassbäring mäts
    // medurs från norr, alltså från y-axeln.
    kurs: fart > 0 ? ((Math.atan2(vx, vy) * 180 / Math.PI) + 360) % 360 : null,
    sigmaKmh: sigma * 3.6,
    n: p.length,
  };
}

/**
 * Glesa ut en punktföljd till högst `tak` punkter, med ändarna kvar.
 *
 * Ändarna först och sist: de bär hela fönstrets längd, och längden är det som
 * dominerar precisionen. Att tappa mitten kostar bara √antal.
 */
function glesa(fixar, tak) {
  if (fixar.length <= tak) return fixar;
  const ut = [];
  const steg = (fixar.length - 1) / (tak - 1);
  for (let i = 0; i < tak; i++) ut.push(fixar[Math.round(i * steg)]);
  return ut;
}

function anvandbarFix(f, g) {
  return !!f && Number.isFinite(f.lat) && Number.isFinite(f.lon) && Number.isFinite(f.ts) &&
    !(Number.isFinite(f.accuracy) && f.accuracy > g.maxOsakerhetM);
}

/**
 * Farten enligt positionerna, med sitt eget felstreck.
 *
 * Anpassar en gång per steg i trappan och väljer sedan det KORTASTE fönster
 * som är både signifikant och uppbackat av nästa längre fönster. Blir inget
 * fönster valt lämnas det LÄNGSTA tillbaka ändå, markerat som osignifikant —
 * det behövs för stillhetsbeviset, som handlar om hur snäv osäkerheten är och
 * inte om hur stor lutningen är.
 *
 * @param {Array} h historiken, äldst först
 * @param {number} i index för fixen vi bedömer
 * @returns {{kmh:number, kurs:number|null, sigmaKmh:number, n:number,
 *            signifikant:boolean, ovreGrans:number}|null}
 */
function passaGren(h, i, g) {
  const nu = h[i];
  // Anpassningen tillskrivs den HÄR fixens tidsstämpel, så den här fixen måste
  // duga. Dopplergrenen har ingen sådan spärr, av skälen vid maxOsakerhetM.
  if (!anvandbarFix(nu, g)) return null;

  // Användbara fixar inom historikfönstret, äldst först.
  const brukbara = [];
  for (let j = 0; j <= i; j++) {
    const f = h[j];
    if (!anvandbarFix(f, g)) continue;
    if (nu.ts - f.ts > g.historikFonsterMs) continue;
    brukbara.push(f);
  }
  if (brukbara.length < 2) return null;

  // Ett fönster per trappsteg, kortast först.
  const steg = [];
  for (const mult of g.passaTrappa) {
    const span = Math.min(mult * g.refFonsterMs, g.historikFonsterMs);
    const del = brukbara.filter(f => nu.ts - f.ts <= span);
    if (del.length >= 2 && nu.ts - del[0].ts >= g.minDtMs) {
      const p = passa(glesa(del, g.passaMaxPunkter), g);
      if (p) {
        // Två punkter är den gamla, ostödda geometrin och får en betydligt
        // hårdare gräns. Se signifikansKPar.
        const k = p.n >= 3 ? g.signifikansK : g.signifikansKPar;
        steg.push({ ...p, signifikant: p.kmh >= k * p.sigmaKmh, ovreGrans: p.kmh + g.stillaK * p.sigmaKmh });
      }
    }
    if (span >= g.historikFonsterMs) break;   // längre steg ger samma punkter
  }
  if (!steg.length) return null;

  // UPPBACKNING AV NÄSTA LÄNGRE FÖNSTER.
  //
  // Ett kort fönster som är signifikant räcker inte i sig. Skälet är mätt: en
  // person som GÅR i 5 km/h med accuracy 30 fick moving = true i nästan hälften
  // av alla femminuterspromenader, därför att ett medellångt fönster då och då
  // slumpade sig till en lutning över sin egen signifikansgräns. Att i stället
  // höja gränsen hade kostat i andra änden — en bil i 30 km/h med accuracy 40
  // ligger själv inte många sigma över, och den ska höras.
  //
  // Skillnaden mellan de två fallen är inte HUR HÖGT utslaget är utan HUR LÄNGE
  // det varar. Verklig fart finns kvar när man tittar dubbelt så långt bak; en
  // fluktuation halveras eller försvinner. Kravet är därför att nästa längre
  // fönster ska visa minst stodFaktor av samma fart.
  //
  // Varför det inte tystar en igångkörning: en bil som just startat har ett
  // längre fönster som spänner över standstill plus körning, alltså ungefär
  // halva farten — precis vad kravet är satt för att släppa igenom. Vid
  // konstant fart visar båda fönstren samma sak, och en inbromsning ger ett
  // LÄNGRE fönster som är högre än det korta, vilket alltid klarar kravet.
  //
  // Sista steget har inget längre fönster att jämföra med och accepteras på sin
  // signifikans ensam. Där är fönstret redan en minut långt, och en lutning som
  // håller i sig en minut är inte en fluktuation.
  for (let j = 0; j < steg.length; j++) {
    if (!steg[j].signifikant) continue;
    const nasta = steg[j + 1];
    if (!nasta || nasta.kmh >= g.stodFaktor * steg[j].kmh) return steg[j];
  }

  // Inget fönster höll. Lämna tillbaka det längsta, osignifikant-märkt: det är
  // det som har snävast felstreck och därför det enda som kan bära ett
  // stillhetsbevis.
  const langsta = { ...steg[steg.length - 1] };
  langsta.signifikant = false;
  return langsta;
}

/**
 * En enda fix omvandlad till "det här vet vi om farten och kursen just nu",
 * eller null om vi inget vet.
 *
 * Tre sorters svar kan komma ut, och alla tre är trovärdiga avläsningar:
 *
 *   'doppler'  — chippets egen mätning.
 *   'skillnad' — en signifikant lutning genom positionerna.
 *   'stilla'   — ingen signifikant lutning, MEN ett så snävt felstreck att
 *                farten bevisligen ligger under körtröskeln. Det är den enda
 *                sortens svar som förra versionen saknade helt, och skälet
 *                till att en telefon utan doppler kunde fastna i körläge.
 *
 * Ingen avläsning alls är något annat än en nolla, och de får aldrig blandas
 * ihop: "vi ser ingen rörelse men vet inte hur långsamt" ska lämna både farten
 * och moving orörda, medan "vi vet att det är under 8 km/h" ska få ändra dem.
 *
 * @param {Array} h  historiken, äldst först
 * @param {number} i index i historiken för fixen vi bedömer
 */
function kandidat(h, i, g) {
  const nu = h[i];
  if (!nu || !Number.isFinite(nu.ts)) return null;

  const doppler = dopplerKmh(nu.speed, g);
  const chipKurs = Number.isFinite(nu.heading) ? ((nu.heading % 360) + 360) % 360 : null;
  const p = passaGren(h, i, g);

  // Kursen ur en anpassning används BARA när lutningen är signifikant. En
  // osignifikant lutning har en jämnt slumpmässig riktning, och alerts.js
  // riktningsfilter hade då kunnat sortera bort en polis rakt fram.
  const passKurs = p && p.signifikant ? p.kurs : null;

  if (doppler != null) {
    let kmh = doppler;
    let kalla = 'doppler';
    // KORSKONTROLL (se dopplerKorsMinKmh). Dopplern vinner nästan alltid, men
    // inte när positionen bevisar något helt annat och mycket större. Att välja
    // det HÖGRE värdet är samma lutning åt körhållet som resten av filen bygger
    // på — den gamla koden valde här systematiskt det lägre.
    if (p && p.signifikant && p.kmh > g.dopplerKorsMinKmh && p.kmh > g.dopplerKorsFaktor * doppler) {
      kmh = Math.min(p.kmh, g.maxSkillnadKmh);
      kalla = 'skillnad';
    }
    // sigmaKmh = 0 för doppler: chippets mätning har inget positionsfelstreck
    // och behandlas som exakt, samma hållning som resten av filen har.
    return { kmh, kalla, kurs: chipKurs != null ? chipKurs : passKurs, sigmaKmh: 0, ts: nu.ts };
  }

  if (!p) return null;

  if (p.signifikant) {
    return {
      kmh: Math.min(p.kmh, g.maxSkillnadKmh),
      kalla: 'skillnad',
      kurs: chipKurs != null ? chipKurs : passKurs,
      sigmaKmh: p.sigmaKmh,
      ts: nu.ts,
    };
  }

  // STILLHETSBEVIS. Ligger hela konfidensintervallets övre kant under
  // körtröskeln har vi visat att bilen inte kör, även om vi inte kan säga om
  // den står still eller går. Farten vi rapporterar är anpassningens egen — en
  // gående får 5 km/h och inte 0, vilket är sant och dessutom under varenda
  // varningsgrind i appen.
  //
  // Varför det inte kan tysta en bil: villkoret handlar om felstreckets STORLEK
  // och inte om lutningen. Kör bilen i 30 ligger ovreGrans över 30, alltså långt
  // över 8, och grenen nås aldrig. Den nås bara när mätningen är både snäv och
  // låg, vilket bara en stillastående eller gående telefon kan ge.
  if (p.ovreGrans < g.borjaKoraKmh) {
    return { kmh: p.kmh, kalla: 'stilla', kurs: null, sigmaKmh: p.sigmaKmh, ts: nu.ts };
  }

  // Kvar: mätningen är för trubbig för att säga något åt något håll. Lämna
  // frågan obesvarad; anroparen behåller det den redan trodde.
  return null;
}

/**
 * Väg samman historiken till ett besked om rörelsen.
 *
 * REN FUNKTION. Ingen klocka, inget GPS, ingen localStorage — allt tillstånd
 * kommer in som `forra` och ut som returvärdet. Samma hållning som chatt.js
 * bedomFart, och av samma skäl: det är det enda sättet att kunna spela upp
 * inspelade fixföljder och se att svaret blir rätt. Se geo-test.html.
 *
 * @param {Array} historik  fixar äldst först, { lat, lon, accuracy, speed, heading, ts }
 * @param {object|null} forra  förra returvärdet från den här funktionen
 * @param {object} granser
 * @returns {{ speedKmh:number|null, heading:number|null, moving:boolean,
 *             kalla:string, fartFarsk:boolean, fartAlderMs:number|null,
 *             lagSedan:number|null, oklarSedan:number|null,
 *             sista:{kmh:number,kurs:number|null,ts:number}|null }}
 */
export function harledRorelse(historik, forra = null, granser = RORELSE) {
  const g = { ...RORELSE, ...(granser || {}) };
  const raHistorik = Array.isArray(historik) ? historik : [];
  const nyaste = raHistorik[raHistorik.length - 1];
  const nu = Number.isFinite(nyaste?.ts) ? nyaste.ts : (Number.isFinite(forra?.sista?.ts) ? forra.sista.ts : 0);

  // GALLRA PÅ TID, inte på antal. Anroparen kan ha ett annat minnestak än vi
  // (geo-test.html har ett eget), och fönstertrappan nedanför måste betyda
  // samma sak oavsett. Att göra det här i stället för bara i #onPosition gör
  // också funktionen ärlig när den spelas upp med en inspelad följd.
  const h = raHistorik.filter(f => Number.isFinite(f?.ts) ? nu - f.ts <= g.historikFonsterMs : true);

  const forraFart = Number.isFinite(forra?.speedKmh) ? forra.speedKmh : null;
  let sista = forra?.sista && Number.isFinite(forra.sista.kmh) ? forra.sista : null;
  let moving = forra?.moving === true;
  let lagSedan = Number.isFinite(forra?.lagSedan) ? forra.lagSedan : null;
  let bandSedan = Number.isFinite(forra?.bandSedan) ? forra.bandSedan : null;
  let heading = Number.isFinite(forra?.heading) ? forra.heading : null;
  let oklarSedan = Number.isFinite(forra?.oklarSedan) ? forra.oklarSedan : null;

  // Kandidater för de senaste fixarna, nyast sist. Bara medianAntal stycken
  // behövs, och bara de som ligger inom medianfönstret.
  const kandidater = [];
  for (let i = h.length - 1; i >= 0 && kandidater.length < g.medianAntal; i--) {
    // Bryt på FIXENS ålder, inte på kandidatens. En fix som inte gav någon
    // kandidat får inte kosta en anpassning till: historiken är nu en minut
    // lång, och att söka igenom hela den minuten efter kandidater vore
    // hundratals anpassningar per fix i stället för tre. Att bryta på
    // kandidatens ålder, som förr, gick bara att göra när historiken var tolv
    // fixar kort.
    if (Number.isFinite(h[i]?.ts) && nu - h[i].ts > g.medianFonsterMs) break;
    const k = kandidat(h, i, g);
    if (!k) continue;
    kandidater.unshift(k);
  }

  const senaste = kandidater[kandidater.length - 1] || null;
  // Bara en kandidat som gäller den fix vi just fick in räknas som färsk. En
  // äldre kandidat i medianfönstret får jämna ut, men inte påstå att vi vet
  // något nytt.
  const farsk = !!senaste && senaste.ts === nu;

  // HUR LÄNGE HAR VI FÅTT BRA FIXAR UTAN ATT LÄRA OSS NÅGOT?
  //
  // Tre lägen, och skillnaden mellan dem är hela poängen med hallMaxMs:
  //   • färsk avläsning        → vi vet något, nollställ räknaren.
  //   • användbar fix, inget svar → räknaren tickar. Telefonen HAR signal och
  //     säger ändå ingenting om rörelse; det är svag men äkta information.
  //   • obrukbar fix eller ingen fix → nollställ. Tunnel och mastgissning är
  //     inte bevis för någonting, och får aldrig driva en nedräkning som till
  //     slut nollar farten mitt i en körning.
  if (farsk) oklarSedan = null;
  else if (anvandbarFix(nyaste, g) && Number.isFinite(nyaste?.ts)) {
    if (oklarSedan == null) oklarSedan = nu;
  } else oklarSedan = null;

  let speedKmh;
  let kalla;

  if (kandidater.length) {
    // Median när vi har tre; färre än så finns det inget att jämna ut med, och
    // då är den nyaste avläsningen ärligare än ett halvt medelvärde.
    let ut = kandidater.length >= g.medianAntal
      ? median(kandidater.map(k => k.kmh))
      : senaste.kmh;

    // GENVÄG FÖRBI EFTERSLÄPNINGEN. Medianen finns för att döda utrusare i
    // POSITIONSbruset. Dopplerfarten har inte det problemet — den mäts per fix
    // på bärvågsskift och behöver ingen utjämning. Ligger den över medianen
    // vinner den, så en verklig igångkörning inte fördröjs en sekund av ett
    // filter som byggdes mot ett annat fel. Att välja det HÖGRE värdet lutar
    // dessutom åt körhållet, vilket är den lutning hela den här filen kräver.
    if (senaste.kalla === 'doppler' && senaste.kmh > ut) ut = senaste.kmh;

    // Rimlighetsspärr, bara uppåt (se maxAccelMs2). Den första avläsningen
    // efter en kallstart är med flit oklampad — skälet står vid konstanten.
    if (forraFart != null && Number.isFinite(forra?.sista?.ts)) {
      const dt = (nu - forra.sista.ts) / 1000;
      if (dt > 0) {
        const tak = forraFart + g.maxAccelMs2 * dt * 3.6;
        if (ut > tak) ut = tak;
      }
    }

    speedKmh = ut;
    kalla = senaste.kalla;
    if (senaste.kurs != null) heading = senaste.kurs;
    if (farsk) sista = { kmh: ut, kurs: senaste.kurs ?? null, ts: nu };
  } else if (sista && !(oklarSedan != null && nu - oklarSedan >= g.hallMaxMs)) {
    // Ingen trovärdig avläsning just nu. HÅLL KVAR den senast kända farten
    // oförändrat i stället för att returnera null eller noll. Konsumenterna
    // läser `fix.speedKmh ?? 0` och hade tolkat båda som "står still", alltså
    // tystnad — i tunneln, under viadukten, mellan höghusen. Där behövs
    // varningarna som mest. Ingen nedtrappning heller: kameravarningens
    // förvarningsavstånd räknas som fart × 25 s, så en dämpad fart flyttar
    // varningen närmare kameran i stället för att tysta den, och det är
    // svårare att upptäcka än total tystnad.
    speedKmh = sista.kmh;
    kalla = 'hallen';
  } else if (sista) {
    // Hållandet har gått ut: hallMaxMs av ANVÄNDBARA fixar utan ett enda svar.
    // Se konstanten för varför det inte kan drabba en bil som rullar. Här
    // släpps både farten och körläget, och `sista` glöms så att nästa
    // signaltapp inte återuppväcker ett värde vi just förkastat.
    speedKmh = 0;
    kalla = 'utgangen';
    sista = null;
    moving = false;
    lagSedan = null;
    bandSedan = null;
  } else {
    // Vi har aldrig haft en trovärdig avläsning. Kallstart: appen öppnas, och
    // en bil som just startat appen står nästan alltid still. Noll och inte
    // null därför att varenda konsument ändå skriver `?? 0` — det ger exakt
    // samma beteende som i dag, utan att sprida NaN eller null vidare.
    speedKmh = 0;
    kalla = 'okand';
  }

  if (!Number.isFinite(speedKmh)) { speedKmh = 0; kalla = 'okand'; }
  speedKmh = Math.max(0, Math.round(speedKmh));

  // Räcker avläsningen för att PÅSTÅ att någon kör?
  //
  // Farten som visas är bästa gissningen; moving är ett påstående om att bilen
  // rullar, och ett påstående ska bära sin egen osäkerhet. En anpassning som
  // säger 10 km/h med ett felstreck på 4 är förenlig med en fotgängare i 5, och
  // det var precis så den gående fick körläge: hans verkliga 5 km/h plus brus
  // råkade landa över 8. Kravet här är därför att hela intervallet ned till
  // movingK sigma ska ligga över körtröskeln.
  //
  // Dopplern undantas (sigmaKmh = 0) och passerar på farten ensam, som förr.
  const farsknog = farsk && (
    !Number.isFinite(senaste?.sigmaKmh) ||
    speedKmh - g.movingK * senaste.sigmaKmh > g.borjaKoraKmh
  );

  // Hysteres. Bara FÄRSKA, trovärdiga avläsningar får röra flaggan; hållna och
  // okända värden lämnar den som den är. Det är därför ett signalbortfall inte
  // kan slå av körläget mitt i en körning.
  if (farsk) {
    if (speedKmh > g.borjaKoraKmh && farsknog) {
      moving = true;
      lagSedan = null;
      bandSedan = null;
    } else if (speedKmh > g.borjaKoraKmh) {
      // Över tröskeln men inte övertygande. Slå varken på eller av, och rör
      // inte heller bandräknaren: att tvinga fram ett "av" här hade gjort en
      // svag men äkta körning till stillastående, alltså exakt det fel som är
      // dyrast av alla i den här filen.
      lagSedan = null;
    } else {
      // Vi har en färsk avläsning och den nådde INTE körtröskeln. Starta den
      // långsamma räknaren (se bandMaxMs) oavsett om vi ligger i bandet eller
      // under det — den finns för att flaggan aldrig ska kunna leva vidare på
      // avläsningar som inte påstår att någon kör.
      if (bandSedan == null) bandSedan = nu;

      if (speedKmh < g.slutaKoraKmh) {
        if (lagSedan == null) lagSedan = nu;
        if (nu - lagSedan >= g.slutaKoraMs) moving = false;
      } else {
        // I hysteresbandet 4–8 km/h: varken på eller av av den snabba
        // räknaren. Krypfart i kö ska inte få flaggan att fladdra.
        lagSedan = null;
      }

      if (nu - bandSedan >= g.bandMaxMs) moving = false;
    }
  }

  return {
    speedKmh,
    heading: Number.isFinite(heading) ? heading : null,
    moving,
    kalla,
    fartFarsk: farsk,
    fartAlderMs: sista ? Math.max(0, nu - sista.ts) : null,
    lagSedan,
    bandSedan,
    oklarSedan,
    sista,
  };
}

export class GeoTracker extends EventTarget {
  constructor() {
    super();
    this.watchId = null;
    this.last = null;          // { lat, lon, accuracy, speed, heading, ts }
    this.history = [];         // senaste positionerna, för fart och kurs
    this.rorelse = null;       // förra svaret från harledRorelse
    this.permission = 'unknown';
  }

  get position() { return this.last; }
  get isTracking() { return this.watchId !== null; }

  start() {
    if (this.watchId !== null) return;
    if (!('geolocation' in navigator)) {
      this.#emit('error', { message: 'Enheten saknar GPS-stöd.' });
      return;
    }
    if (bestamGrind() !== 'oppen') {
      // Inte ett fel: föraren har bara inte fått frågan förklarad än.
      // slappFramPlats() startar oss så fort hen svarat, och nödutgången
      // startar oss ändå om ingen dialog dyker upp.
      vantandeSparare.add(this);
      this.#emit('vantar', { grind: grindLage() });
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      p => this.#onPosition(p),
      e => this.#onError(e),
      // timeout och rörelseberäkningens längsta tillåtna fixintervall är samma
      // tal, hämtat ur samma konstant. Förr stod 20000 här och 15000 där, och
      // ett fixintervall på 16–20 s var därför normalt för spåraren men tyst
      // för fartberäkningen. Två tal som beskriver samma sak ska vara ett.
      { enableHighAccuracy: true, maximumAge: 1000, timeout: GPS_TIMEOUT_MS }
    );
  }

  stop() {
    // Stod vi i kö bakom grinden ska vi inte startas av ett senare
    // slappFramPlats — någon har uttryckligen bett oss sluta.
    vantandeSparare.delete(this);
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    // Glöm historiken och rörelsetillståndet.
    //
    // Förr låg de kvar, och efter en paus kunde en fix från förra körningen
    // paras ihop med den första nya. Nu när fart hålls kvar över signaltapp
    // vore det värre än förr: appen hade återstartat med "kör i 90" från en
    // resa som slutade i går. Ett medvetet stopp är den enda punkt där vi
    // faktiskt VET att vi inte längre vet något, och då ska vi säga det.
    this.history = [];
    this.rorelse = null;
  }

  #onPosition(p) {
    const c = p.coords;
    const fix = {
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy,
      speed: c.speed,                 // m/s eller null
      heading: c.heading,             // grader eller null
      ts: p.timestamp || Date.now(),
    };

    // Alla fixar hamnar i historiken, även de osäkra. Gallringen sker vid
    // ANVÄNDNING i harledRorelse i stället — historiken ska vara en ärlig logg
    // över vad webbläsaren faktiskt sa, inte en redan tolkad version av den.
    this.history.push(fix);

    // GALLRA PÅ TID. Det gamla taket var ett ANTAL fixar, och ett antal betyder
    // olika saker på olika enheter: tolv fixar är elva sekunder vid 1 Hz men
    // bara två vid 5 Hz. Fartberäkningens fönster mäts i sekunder, så ett
    // antalstak lät enhetens fixtakt tyst bestämma hur långt bak den fick
    // titta — och på en enhet med tät fixtakt kortades fönstret så mycket att
    // ingen fart alls kom fram. Nu styr tiden, och antalet är bara ett
    // minnestak för enheter som skickar orimligt tätt.
    const grans = fix.ts - RORELSE.historikFonsterMs;
    while (this.history.length > 1 && Number.isFinite(this.history[0].ts) && this.history[0].ts < grans) {
      this.history.shift();
    }
    while (this.history.length > RORELSE.historikTak) this.history.shift();

    this.rorelse = harledRorelse(this.history, this.rorelse);
    fix.headingSmoothed = this.rorelse.heading;
    fix.speedKmh = this.rorelse.speedKmh;
    fix.moving = this.rorelse.moving;
    // Extra fält, inte lästa av någon i dag. De finns för att skillnaden mellan
    // "vi mätte just nu" och "vi håller kvar det vi senast visste" ska gå att
    // se utifrån, i stället för att gömmas i en siffra som ser färsk ut.
    fix.fartFarsk = this.rorelse.fartFarsk;
    fix.fartKalla = this.rorelse.kalla;

    this.last = fix;
    this.permission = 'granted';
    this.#emit('position', fix);
  }

  #onError(e) {
    const msg = {
      1: 'Platsåtkomst nekad. Tillåt plats i webbläsarens inställningar.',
      2: 'Ingen GPS-signal.',
      3: 'GPS-timeout.',
    }[e.code] || 'GPS-fel.';
    if (e.code === 1) this.permission = 'denied';
    this.#emit('error', { code: e.code, message: msg });
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

/**
 * Engångsposition — används när man rapporterar "här".
 *
 * Grinden gäller inte här. Det här anropet sker alltid i ett fingertryck som
 * föraren själv gjort för att peka ut en plats, alltså med samma förklaring
 * som grinden finns för att ge — bara i form av handling istället för text.
 * Går det igenom öppnas grinden, så watchPosition slipper stå och vänta på en
 * fråga som redan är besvarad.
 */
export function currentPosition(timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Ingen GPS'));
    navigator.geolocation.getCurrentPosition(
      p => {
        slappFramPlats('rapport');
        resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy });
      },
      e => reject(e),
      { enableHighAccuracy: true, timeout, maximumAge: 5000 }
    );
  });
}

/*
 * Första starten ritas av js/platsstart.js.
 *
 * Dynamisk import, inte en vanlig, av två skäl. Dels behöver platsstart.js
 * geo.js och inte tvärtom — en statisk import åt det här hållet hade blivit en
 * cirkel. Dels ska en trasig dialogruta aldrig kunna hindra GPS:en från att
 * starta: går importen fel fångas det här, och nödutgången i grinden öppnar
 * den av sig själv.
 *
 * Ansvaret ligger i den här filen därför att det är watchPosition ovanför som
 * utlöser platsrutan. Den som äger frågan ska också se till att den ställs
 * begripligt.
 */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  import('./platsstart.js').catch(() => slappFramPlats('platsstart-saknas'));
}
