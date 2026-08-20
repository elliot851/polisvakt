# Körfältsanvisning — vilka filer leder rätt

`docs/navigering.md` listar under *Vad det här inte är* körfältsanvisning som
saknad, med noteringen att OSRM redan har `steps[].intersections[].lanes` i
svaret vi hämtar. Det stämde. Datan kom gratis; det som saknades var tolkningen.

Den här filen beskriver tolkningen: vilken korsning filerna hämtas ur, vilken
fil som är bäst att ligga i, när anvisningen ska utebli, och varför den aldrig
läses upp.

- Kod: [`js/navigering.js`](../js/navigering.js), avsnittet *Körfältsanvisning*
- Tester: [`navigering-test.html`](../navigering-test.html), gruppen *Körfält*
- Modulen den bor i: [navigering.md](navigering.md)

---

## Innehåll

1. [Den läses aldrig upp](#den-läses-aldrig-upp)
2. [Formen du får ut](#formen-du-får-ut)
3. [Att rita den](#att-rita-den)
4. [Vilken korsning filerna kommer ur](#vilken-korsning-filerna-kommer-ur)
5. [Vilken fil som är bäst](#vilken-fil-som-är-bäst)
6. [När anvisningen uteblir](#när-anvisningen-uteblir)
7. [API](#api)
8. [Vad OSRM:s data inte räcker till](#vad-osrms-data-inte-räcker-till)
9. [Testresultat i siffror](#testresultat-i-siffror)

---

## Den läses aldrig upp

Det här är avsnittets viktigaste beslut och det är samma sorts beslut som
prioritetsordningen i [navigering.md](navigering.md): **röstkanalen är
enkelspårig och den är redan full.**

Polisvarningar ligger på prioritet 1 och 2, svängbeskrivningar på 0, och
`Speaker` sorterar kön fallande. Ett fjärde slags yttrande — *"håll dig i de två
högra filerna"* — hade gjort tre saker, alla dåliga:

1. **Det tar tid.** Meningen är tre till fyra sekunder i talsyntes, och under
   den tiden kan ingenting annat sägas. Det är ungefär den tid en
   fartkameravarning behöver för att komma fram medan den fortfarande är sann.
2. **Det upprepar.** Den handlar om exakt samma manöver som svängbeskrivningen
   just sagt något om. Den hade alltså trängt undan något viktigare för att
   säga om något föraren nyss hört.
3. **Det går inte att kontrollera med örat.** "De två högra" betyder olika saker
   beroende på hur många filer man faktiskt ser framför sig. Den som är osäker
   tittar upp på skylten ändå.

Filval är ögats uppgift. Föraren ser filerna och behöver matcha det hen ser mot
en **bild**. En pil-rad som ligger kvar på skärmen går att titta på tre gånger
under de tjugo sekunder man har på sig; en mening finns bara i ögonblicket den
sägs och är sedan borta.

Därför returnerar hela det här avsnittet bara data. Ingen funktion i det skapar
ett yttrande, ingenting därifrån hamnar någonsin i `tal`, och `Navigering`
lägger resultatet på tillståndet under `korfalt` — **vid sidan av talet, aldrig
i det.** Ett test låser fast det: samma rutt med och utan filuppgifter ger exakt
lika många talade besked.

---

## Formen du får ut

`tillstand().korfalt` är antingen `null` eller ett objekt. Filerna ligger i
`filer[]` **från vänster till höger** i färdriktningen — samma ordning OSRM
använder, oförändrad.

```js
{
  antal: 4,
  filer: [
    { index: 0, giltig: false, rekommenderad: false,
      riktningar: ['rakt'], vinklar: [0], symboler: ['↑'],
      dedikerad: true, huvud: null, ratt: false },
    { index: 1, giltig: false, rekommenderad: false,
      riktningar: ['rakt'], vinklar: [0], symboler: ['↑'],
      dedikerad: true, huvud: null, ratt: false },
    { index: 2, giltig: true,  rekommenderad: false,
      riktningar: ['rakt', 'svagt-höger'], vinklar: [0, 45], symboler: ['↑', '↗'],
      dedikerad: false, huvud: 'svagt-höger', ratt: true },
    { index: 3, giltig: true,  rekommenderad: true,
      riktningar: ['svagt-höger'], vinklar: [45], symboler: ['↗'],
      dedikerad: true, huvud: 'svagt-höger', ratt: true },
  ],
  bastaIndex: 3,
  giltiga: [2, 3],
  grupp: { fran: 2, till: 3, antal: 2, sida: 'höger', sammanhangande: true },
  manover: { kod: 'svagt-höger', vinkel: 45, typ: 'off ramp', modifier: 'slight right' },
  kalla: 'manover',        // eller 'infart'
  kallaAvstandM: 0,        // hur långt före manöverpunkten korsningen låg
  korsningPunkt: [59.61, 16.58],
  stegIndex: 3,            // sätts av Navigering
  avstandM: 420,           // bilens avstånd kvar till manövern
}
```

### Fälten, ett i taget

| Fält | Betyder |
|---|---|
| `filer[].giltig` | OSRM:s `valid` — leder filen dit vi ska? Det här är det auktoritativa fältet. |
| `filer[].rekommenderad` | `index === bastaIndex`. Exakt en fil har den. |
| `filer[].riktningar` | Koder, sorterade vänster→höger inom filen. Se tabellen nedan. |
| `filer[].vinklar` | Grader. **0 = rakt fram, negativt = vänster.** Det är allt som behövs för att rita pilen; gränssnittet behöver aldrig känna till OSRM:s ordlista. |
| `filer[].symboler` | Pilar att falla tillbaka på om du inte ritar egna. |
| `filer[].dedikerad` | Filen gör bara en sak. En delad fil kan blockeras av någon som ska någon annanstans. |
| `filer[].huvud` | Vilken av filens pilar som ska lysa. `null` på spärrade filer. |
| `filer[].ratt` | Filens skyltning tillåter manövern. Skiljer sig ibland från `giltig` — se nedan. |
| `grupp` | Det sammanhängande blocket av giltiga filer runt den bästa. |
| `grupp.sida` | `'vänster'` \| `'höger'` \| `'mitten'`. |
| `grupp.sammanhangande` | Ligger **alla** giltiga filer i blocket? |
| `kalla` | `'manover'` = filerna kom från manöverkorsningen. `'infart'` = från en sent delande korsning i steget före. |

**`giltig` och `ratt` är inte samma sak.** `giltig` kommer från OSRM och betyder
"den här filen leder vidare längs rutten". `ratt` är vår egen jämförelse mellan
filens pilar och manöverns riktning. De går isär när OSM och OSRM inte är
överens om skarpheten på en sväng — en avfart OSRM kallar `slight right` är i
OSM ofta skyltad `right`. **Lita på `giltig`.** `ratt` finns för att kunna färga
en pil, inte för att fatta beslut.

### Riktningskoderna

Avsiktligt **inte** svensk text. Presentationen ägs av gränssnittet; det här är
en stabil kod och en vinkel.

| OSRM | Kod | Vinkel | Pil |
|---|---|---|---|
| `straight` | `rakt` | 0° | ↑ |
| `slight right` | `svagt-höger` | 45° | ↗ |
| `right` | `höger` | 90° | ↱ |
| `sharp right` | `skarpt-höger` | 135° | ⮡ |
| `slight left` | `svagt-vänster` | −45° | ↖ |
| `left` | `vänster` | −90° | ↰ |
| `sharp left` | `skarpt-vänster` | −135° | ⮢ |
| `uturn` | `u-sväng` | −180° | ⮐ |
| `merge to left` | `fila-vänster` | −30° | ↖ |
| `merge to right` | `fila-höger` | 30° | ↗ |
| `none` | `ingen` | 0° | ↑ |

`none` är en fil utan filpilar i vägbanan. Den säger ingenting om riktning, och
den straffas inte för det — `giltig` avgör ändå om den duger.

Versaler och understreck normeras (`Slight_Right` → `svagt-höger`). En riktning
som inte finns i tabellen blir `null` och hoppas över i stället för att bli en
gissning.

---

## Att rita den

Panelen hör hemma **under** manöverskylten och **ovanför** resefältet, alltså i
den ordning ögat läser dem: vad ska jag göra, i vilken fil, hur långt kvar.

Minsta möjliga:

```js
function ritaKorfalt(korfalt) {
  const rad = document.getElementById('korfalt');
  if (!korfalt) { rad.hidden = true; return; }   // null betyder rita ingenting
  rad.hidden = false;
  rad.innerHTML = korfalt.filer.map(f => `
    <span class="fil ${f.giltig ? 'leder-ratt' : 'sparrad'}
                      ${f.rekommenderad ? 'bast' : ''}">
      ${f.vinklar.map((v, i) =>
        `<i class="pil ${f.riktningar[i] === f.huvud ? 'huvud' : ''}"
            style="--vinkel:${v}deg"></i>`).join('')}
    </span>`).join('');
}
```

Tre saker som är värda att göra rätt:

- **`null` betyder dölj, inte "vänta".** Raden ska bort helt, inte visas tom.
  Se [När anvisningen uteblir](#när-anvisningen-uteblir) — den är null största
  delen av en resa, och det är meningen.
- **Spärrade filer ska synas, men dämpat.** Poängen med raden är att föraren ska
  kunna räkna filerna framför sig och matcha. Ritar man bara de giltiga stämmer
  inte antalet med verkligheten och raden blir farligare än ingen rad alls.
- **Vinkeln är en `rotate()`, inte en uppslagning.** `--vinkel` rakt in i
  `transform: rotate(var(--vinkel))` på en pil som pekar uppåt. Då behöver
  gränssnittet aldrig känna igen `skarpt-vänster`.

Vill du skriva text i stället för att rita — `grupp` är till för det:

```js
// "de två högra filerna", "vänstra filen", "de tre mittersta filerna"
if (korfalt.grupp.sammanhangande) {
  const n = korfalt.grupp.antal, sida = korfalt.grupp.sida;
  // …bygg strängen här. Modulen bygger den med flit inte åt dig.
}
```

**Kolla `sammanhangande` först.** Är den `false` ligger giltiga filer på båda
sidor om en spärrad — det händer där vägen delar sig åt båda hållen — och då är
"de två högra filerna" bara halva sanningen. Rita raden, skriv ingen text.

### Kartrotation

Om du ritar pilarna som tecken (`symboler`) gäller samma sak som för
farornålarna och manöverpilarna: de måste in i ett `<span class="pv-upright">`,
annars ligger de på sidan så fort kartan vrids. Ritar du dem med `rotate()` i
en panel utanför kartan är det inget problem.

---

## Vilken korsning filerna kommer ur

Ett OSRM-steg bär `intersections`, en post per korsning man passerar under
steget. Manövern utförs vid steget **början**, och `intersections[0]` ligger per
definition på `maneuver.location`.

**Regel 1: `intersections[0]` i manöversteget.** Dess `lanes` beskriver infarten
till just den korsningen — exakt det val föraren står inför.

**`intersections[1]` och framåt läses aldrig.** De är korsningar man kör igenom
*efter* manövern. Det är inte en teoretisk finess: i provkörningen Västerås →
Stockholm bär steg 7 (den långa E18-etappen) **femton** lane-bärande
korsningar, alla med mönstret `[none] [none] (slight right)`. Det är avfarterna
man passerar utan att ta dem. Hade de lästs hade fil-raden tänts femton gånger
på åtta mil motorväg, varje gång för att berätta att man ska fortsätta rakt
fram. En panel som alltid lyser slutar man titta på.

**Regel 2: filer som delar sig sent.** Saknar manöverkorsningen filuppgifter
görs ett andra försök mot **sista** korsningen i föregående steg — men bara om
den ligger inom `korfaltNaraM` (120 m) från manöverpunkten. Svenska
trafikplatser skyltar ofta filerna på en nod strax före den nod OSRM valt som
manöverpunkt.

Gränsen är uppmätt, inte gissad. I samma provkörning ligger filskyltningen inför
påfarten mot Stockholm på en nod **95 m** före manöverpunkten — samma
vägdelning, samma beslut. Närmaste lane-bärande korsning som *inte* hörde ihop
med sin manöver låg **946 m** bort. 120 m ligger med god marginal mellan de två.

Sökningen bakåt avbryts vid första korsning som bär filer. De som ligger före
den ligger ännu längre bort, och att fortsätta leta vore att leta efter fel svar.

---

## Vilken fil som är bäst

**"Första giltiga" är fel svar**, och det syns tydligast i en avfart.

Är filerna `[rakt] [rakt] [rakt, svagt höger] [svagt höger]` och avfarten går åt
höger, så är både fil 2 och fil 3 giltiga. Men fil 2 delas med
genomfartstrafiken: där står man bakom någon som ska rakt fram, och kan bli
tvungen att byta fil i sista stund ändå. Fil 3 är avfartsfil och kan inte
blockeras av någon som ska någon annanstans. **Svaret är fil 3.**

Tre saker viktas, i den ordningen:

| Vad | Vikt | Varför |
|---|---|---|
| Skyltningen matchar manövern | 40 per steg (0–2) | En fil skyltad för just den här manövern slår en fil som bara råkar vara godkänd. |
| Filen är dedikerad | +12 | En fil som bara gör det vi ska göra kan inte blockeras. |
| Varje extra riktning på filen | −4 | Ytterligare någon som kan stå i vägen. |
| Läget i vägbanan | 3 × riktning × index | Vid högermanöver vinner den högsta giltiga filen, vid vänstermanöver den lägsta — ett filbyte mindre kvar att göra. |

Vikterna är rangordningen uttryckt i tal, inte finkalibrering: dedikering väger
tyngre än ett enskilt steg i sidled, men lättare än en riktig skyltningsträff.

**Skyltningsträffen har en grannmarginal på 45°.** OSM och OSRM är inte alltid
överens om skarpheten på en sväng, och att räkna `right` som fel fil för en
manöver OSRM kallar `slight right` vore att slänga rätt svar.

**Vid lika poäng och rak manöver vinner den högra filen.** Trafikförordningen
3 kap. 6 § — fordon förs på högra delen av vägen — och det håller en dessutom
borta ur omkörningsfilen.

### Det bästa är inte alltid en ytterfil

Är filerna `(rakt) [svagt höger] [svagt höger] (höger)` — ytterfilerna spärrade
åt var sitt håll — är varken "första giltiga" (1) eller "längst åt
manöverhållet" (3) rätt. Svaret är fil 2, och `grupp.sida` blir `'mitten'`.

---

## När anvisningen uteblir

En skärm som alltid visar samma sak slutar man titta på. `korfalt` är därför
`null` så snart den inte bär ett val:

| Läge | Varför |
|---|---|
| `lanes` saknas eller är tom | Mycket vanligt i svensk OSM-data. Ingen anvisning, punkt. |
| Färre än två filer | Inget att välja mellan. |
| **Alla filer giltiga** | Alla leder rätt. Anvisningen hade bara upprepat "kör på". |
| Ingen fil giltig | Datan är trasig. Att peka på en fil vi inte tror på är värre än att peka på ingen. |
| Manövern är `depart` eller `arrive` | Det finns inget filval i att starta bilen eller vara framme. |
| `lage === 'avvikande'` | Vi vet inte var på rutten bilen är. Att peka ut en fil i en korsning föraren kanske redan passerat är sämre än att visa ingenting. |
| Manövern längre bort än `langt`-horisonten | Se nedan. |

**Avståndsgränsen är `utlosare().langtM`** — samma fartskalade avstånd som
rösten använder för sin första förvarning (500 m i 30 km/h, 764 m i 50, 1,7 km i
110). Före den punkten är ett filbyte inte något man kan agera på; man vet inte
ens vilken avfart det gäller. Horisonten skalar med farten av sig själv, precis
som svängbeskrivningarna.

Det betyder att `korfalt` är `null` under största delen av en resa. Det är inte
en brist — det är hela poängen. När raden tänds betyder det något.

---

## API

```js
import {
  korfaltAnvisning, tolkaRiktning, valjKorfaltsKorsning,
} from './js/navigering.js';
```

| Signatur | Gör |
|---|---|
| `korfaltAnvisning(steg, innan?, opts?) → objekt \| null` | Ren funktion. `steg` = OSRM-steget vars manöver vi närmar oss, `innan` = steget före (för sent delande filer). `opts`: `{ korfaltNaraM = 120, korfaltMinFiler = 2 }`. Inget tillstånd, ingen klocka, inget nät. |
| `tolkaRiktning(indikation) → {kod, vinkel, symbol} \| null` | En OSRM-riktning till något ritbart. Normerar versaler och understreck. `null` på okänd riktning. |
| `valjKorfaltsKorsning(steg, innan?, narM?) → {korsning, kalla, avstandM} \| null` | Bara korsningsvalet, utsprängt för att gå att testa och felsöka för sig. |

Två nya nycklar i `NAV_STANDARD`: `korfaltNaraM: 120` och `korfaltMinFiler: 2`.
Båda går att skriva över med `new Navigering({ … })` eller `setOptions()`.

Ett nytt fält på tillståndsobjektet: **`korfalt`**. Inget befintligt fält har
ändrats, och inget nytt yttrande har tillkommit.

---

## Vad OSRM:s data inte räcker till

Ärlig lista, i ordning efter hur mycket det märks.

### Täckningen är tunn, och det är kartans fel snarare än OSRM:s

Provkörningen Västerås centrum → Drottninggatan Stockholm, 105,5 km, 18 steg:

| | |
|---|---|
| Korsningar totalt i svaret | 117 |
| Korsningar som bär `lanes` | 21 |
| Korsningar som bär `lanes` **och** är manöverkorsning | 1 |
| Manövrar som `korfaltAnvisning()` gav svar på | 3 |
| Manövrar föraren **faktiskt** ser en fil-rad för | **2** |

Skillnaden mellan 3 och 2 är värd en rad: den tredje sitter på ett
`new name`-steg (*"fortsätt på Uppsalavägen"*). Filerna där är äkta —
`[rakt] [rakt*] (svagt-höger)`, högerfilen leder av vägen — men
`#nastaHandling()` hoppar över namnbyten, så steget blir aldrig `nastaManover`.
Att tända en fil-rad utan en manöverskylt över sig vore att visa ett svar på en
fråga som inte ställts. Den rena funktionen svarar ändå på steget; det är
`Navigering` som filtrerar, och det är rätt ordning.

Två av arton. Datan kommer ur OSM:s `turn:lanes`-taggar, som i Sverige är satta
i storstädernas trafikplatser och nästan ingen annanstans. **Det går inte att
lova körfältsanvisning som en funktion man kan räkna med** — bara som en
funktion som finns där kartan är bra nog. Det är samma slutsats som
[navigering.md](navigering.md) drar om trafikdata, av samma sorts skäl.

Det här blir bättre av sig självt när OSM förbättras, och det blir bättre direkt
om appen någon gång byter till en betald ruttjänst. Mapbox och HERE levererar
egen filinformation med betydligt bättre täckning, och båda skickar dessutom
`valid_indication` som pekar ut vilken pil som ska lysa. Formen den här modulen
returnerar är redan förberedd för det fältet.

### Filerna räknas, men de ligger inte var som helst

OSRM säger *hur många* filer det finns och *vad var och en tillåter*. Den säger
ingenting om filbredd, om vägrenen räknas, eller om en av filerna är en
busskörfält som bara gäller vissa tider. En fil-rad med fyra pilar kan alltså
motsvara tre körfält och en bussfil i verkligheten. Det är den enskilt största
källan till att raden inte stämmer med det föraren ser.

### Vi vet inte vilken fil bilen ligger i

GPS är på tiotals meter när, filer är 3,5 m breda. Anvisningen kan därför bara
säga *vilken fil som är rätt*, aldrig *hur många filer du behöver byta*. Waze
och Google gissar inte heller på det.

### Ingen filnivå i tid

`lanes` är statisk. Att en avfartsfil står full och att man behöver lägga sig i
den tre kilometer tidigare än vanligt är trafikdata, och sådan finns inte. Se
*Trafik finns inte. Alls.* i [navigering.md](navigering.md).

### `valid` gäller rutten, inte lagligheten

En fil markerad `valid: false` betyder "den här filen tar dig inte dit du ska",
inte "det är förbjudet att köra där". Skillnaden spelar roll om gränssnittet
någon gång vill skriva ut något med ordet "får" i.

### Vänstertrafik

Filerna kommer från OSRM i ordningen vänster→höger sett i färdriktningen, och
det gäller även i vänstertrafik. Ordningen behöver alltså inte vändas. Däremot
är tumregeln "vid lika poäng vinner den högra filen" högertrafikens, och den
skulle behöva speglas om appen någon gång körs i Storbritannien. Det är den enda
platsen i koden där det antagandet finns.

---

## Testresultat i siffror

`navigering-test.html` mot `serve.ps1` på port 8331: **84 av 84 gröna, 0
misslyckade, 0 hoppade.** Av dem är 23 nya för körfält; de 61 befintliga är
oförändrade och fortfarande gröna.

| Vad | Uppmätt |
|---|---|
| Avfart, 4 filer, 2 giltiga | giltiga `[2,3]`, bäst **3**, grupp 2 filer åt höger, sammanhängande |
| Bästa filen ≠ första giltiga | valde 3, första giltiga var 2 |
| Giltiga filer mitt i vägbanan | giltiga `[1,2]`, bäst **2**, sida `mitten` |
| Alla filer giltiga | **ingen anvisning** |
| Korsning utan `lanes` (fem tomfall) | **ingen anvisning, ingen krasch** |
| Fil med tre riktningar | `['vänster','rakt','höger']`, vinklar `[-90,0,90]`, dedikerad `false`, huvud `höger` |
| Filer efter manövern (`intersections[1]`) | **lästes inte** |
| Sent delade filer, 25 m före | källa `infart`, `kallaAvstandM` 25, bäst 1 |
| Skarpt uppmätt 95-metersdelning | källa `infart`, `kallaAvstandM` 95 |
| 125 m, 200 m och 946 m före | **ingen anvisning** i alla tre |
| Filanvisning inom förvarningshorisont (50 km/h) | ingen vid 1000 m kvar, **anvisning vid 498 m** (`langtM` = 764) |
| Av rutten | läge `avvikande`, `korfalt` **null** |
| Rutt utan filuppgifter, hela vägen | **0** påhittade anvisningar |
| **Talade besked, med filer / utan filer** | **4 / 4 — filanvisningen skapar noll yttranden** |
| Prioriteter bland yttrandena | `[0]`, oförändrat |

### Skarp provkörning

Kedjan kördes mot den riktiga demoservern, Västerås → Stockholm, och hela rutten
kördes sedan igenom `Navigering` fix för fix i 90 km/h:

| | |
|---|---|
| Rutt | 105,5 km, 18 steg, svar från `router.project-osrm.org` |
| GPS-fixar | 4207 |
| Talade besked | 21 — **oförändrat av körfältsarbetet** |
| Fil-rader föraren ser | **2** |
| Andel av resan med fil-rad på skärmen | **1,7 %** (72 fixar av 4207) |

De två raderna:

```
steg 7 · "ta påfarten till höger mot Stockholm"      tänds 410 m före
(vänster) [rakt*]

steg 8 · "håll vänster mot Kistapåfarten"            tänds 1366 m före
[ingen*] [ingen] (svagt-höger)
```

Den första kom via 95-metersregeln och hade tappats helt med det ursprungliga
40-metersfönstret. Den andra kom från manöverkorsningen: två giltiga filer till
vänster, avfartsfilen till höger spärrad, bästa filen längst till vänster.
Filerna är omarkerade i OSM (`none`), vilket är varför raden visar `ingen` i
stället för `rakt` — och varför det är `giltig` och inte skyltningen som styr.

**1,7 % är siffran som betyder mest här.** Raden är släckt 98 av 100 sekunder,
och det är precis vad som gör att den är värd att titta på de två sista.

Att beskeden blev 21 och inte 23 som `navigering.md` uppger beror på att OSRM nu
returnerar en något annan väg — 18 steg och 105,5 km i stället för 19 och 106.
Talvägen är orörd av det här arbetet, vilket testet *"filanvisningen läses aldrig
upp som tal"* låser fast: samma bana med och utan filuppgifter ger exakt lika
många besked.

**Kör om provkörningen efter större ändringar.** Den avslöjade
femton-korsningar-på-E18-fällan och 95-metersgränsen, och ingendera syntes i
enhetstesterna.

### Att köra testerna

```powershell
Start-Process powershell -ArgumentList '-NoProfile','-File','.\serve.ps1','-Port','8331' `
  -WindowStyle Hidden -WorkingDirectory '<repo>'
# öppna http://localhost:8331/navigering-test.html
```

Resultatet ligger i `window.__resultat` som `{ ok, fel, hopp, total, matt }`.
Körfältsvärdena heter `avfartFyraFiler`, `bastaMittIVagbanan`, `deladFil`,
`sentDeladeFiler`, `korfaltHorisont`, `korfaltTystnad` och `riktningskoder`.
