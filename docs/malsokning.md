# Målsökning i skyltläsaren

## Vad som var fel

Läsaren krävde att registreringsskylten hamnade inuti en fast ruta mitt i
bilden. Det är ett krav på verkligheten, inte på programmet. Telefonen sitter i
en hållare, vinkeln är den den är, och skylten hamnar där den hamnar — oftast i
nedre halvan, ofta ute åt sidan. Att be föraren rikta om telefonen i rörelse är
inte ett svar.

Rutan ska följa skylten. Inte tvärtom.

## Vad som gör det

Fyra steg, i den ordningen. Inget av dem är nytt i sig — det som är nytt är att
de tre första kommer före textigenkänningen i stället för att ersätta den.

### 1. Sökning i hela bilden

`sokKandidater(kalla, omrade, { arbetsbredd, max })` skalar ner bilden, trösklar
med Otsu och plockar ut alla ljusa sammanhängande områden som har skyltens
grovform: kvot 2,2–8, fyllnad över 0,45, minst 2,5 % av bildens bredd. Det är
exakt samma test som `hittaPlat` alltid har använt inne i siktrutan — bara
tillämpat på hela bilden.

Flera kandidater kan finnas samtidigt: bilen framför och en parkerad bredvid.
Alla returneras, rangordnade. Rangordningen avgör inte vad som *är* en skylt,
den avgör vad vi tittar på först.

Poängen är fyra faktorer mellan 0 och 1 som multipliceras. Multiplikation och
inte summa: en kandidat som är uppenbart fel i ett avseende ska falla, inte
kompenseras av att den är stor.

| Faktor | Vad den mäter | Varför |
|---|---|---|
| `form` | avstånd från kvoten 4,7 | Svenska skyltar är 520 × 110 mm. Avvikelsen mäts logaritmiskt, så 2,35 och 9,4 straffas lika. En skylt sedd snett trycks ihop i sidled, aldrig i höjdled. |
| `storlek` | bredd i andel av bilden | Under en tredjedel av bilden är avståndet det som avgör om läsningen lyckas. Över det spelar det ingen roll längre. |
| `centrum` | avstånd från bildmitten | Bilen man följer ligger mitt i vägen. Höjdled väger en tredjedel så tungt — skylten hamnar nästan alltid i nedre halvan, det är normalfallet och inget skäl att misstro den. Faktorn bottnar på 0,4 och kan aldrig ensam döda en kandidat: en skylt i hörnet är fortfarande en skylt. |
| `tecken` | antal ljus/mörk-växlingar tvärs området | Den enda faktorn som får döda en kandidat. Se nedan. |

### 2. Tecken — skillnaden mellan en skylt och en skåpbilsdörr

En vit skåpbilsdörr, en vägskylts baksida och ett vitt klistermärke är alla
ljusa, avlånga och rektangulära. Formen ensam kan inte skilja dem från en skylt,
och låser siktet på fel sak läser den fel skylt och visar den med tillförsikt.
Det är värre än att missa.

Det de saknar är tecken. En skylt har sex mörka pelare med ljust emellan:
tolv till fjorton växlingar räknat kolumn för kolumn. En slät yta har noll.
Tröskeln tas lokalt ur området — en skylt i skugga är mörkare än en soldränkt
vägbana, och en global tröskel hade gjort hela skylten svart. Saknar området
kontrast alls (mindre än 40 nivåer mellan mörkast och ljusast) är det per
definition slätt.

Mätt: skylt 12–14 växlingar, poäng 0,61–0,92. Vit skåpbilsdörr 0 växlingar,
poäng 0,08. Låsgränsen ligger på 0,16.

Räkningen kräver att kandidaten är minst 24 pixlar bred i arbetsupplösning för
att vara pålitlig. Är den mindre svarar vi varken ja eller nej utan lägger oss
mitt emellan — annars hade varje skylt på håll dömts ut.

### 3. Spårning mellan bildrutor

`Malsokare` kopplar ihop kandidater mellan bildrutor. En kandidat är samma som
förra bildrutans om den ligger nära (mindre än 0,7 kandidatbredder bort) och är
ungefär lika stor (0,55–1,8 gånger). Bilen framför kan komma närmare mellan två
bildrutor, men den kan inte fördubbla sin skylt på 120 ms.

Vid tveksam matchning får det låsta spåret välja först. Annars stjäl en nyfödd
ljusfläck låsets kandidat.

Rutan glider mot den nya mätningen med 0,4 i stället för att hoppa dit. Rå
mätning skakar en pixel hit och dit varje bildruta, och ett sikte som darrar ser
trasigt ut även när det sitter.

### 4. Låset

| Värde | Satt till | Varför |
|---|---|---|
| Sökintervall | 120 ms | Sökningen kostar ~2,5 ms. Åtta gånger i sekunden är under två procent av en kärna och tillräckligt tätt för att ett lås ska hinna byggas medan man kör om. |
| Bildrutor för lås | 8 | 8 × 120 ms ≈ 0,96 s. Ett sikte som låser omedelbart låser lika gärna på en solreflex; en sekund är kort nog att kännas följsam och lång nog att en tillfällig fläck ska ha hunnit försvinna. |
| Tapp innan låset släpper | 3 | 360 ms. Ett par bildrutor. Kortare och varje vindrutetorkarsvep släpper låset, längre och siktet står kvar och pekar på en bil som svängt av. |
| Tapp innan olåst spår slopas | 2 | En kandidat utan lås har inget värde att bevara. |
| Minsta poäng för lås | 0,16 | Under den låser vi inte, hur ensam kandidaten än är. Satt så att en slät ljus yta (0,08) hamnar under, medan den svåraste riktiga skylten i mätningen — 220 px uppe i ett hörn, 0,61 — har god marginal. |
| Läsningar innan låset brinner | 3 | Se nedan. |

Låset är klibbigt med flit. En kandidat med högre poäng tar inte över ett
sittande lås — det är det som gör det till ett lås och inte en rangordning.
Låset släpps bara på två sätt: målet försvinner, eller låset brinner upp.

### Bränt lås

En kandidat som gång på gång skickas till textigenkänningen utan att någonsin ge
en giltig skylt är inte en skylt. Efter tre sådana läsningar bränns spåret: låset
släpps och kandidaten utesluts från att låsas igen så länge den syns i bild.
Nästa kandidat får chansen.

En kandidat som en gång gett en giltig skylt bränns aldrig — bomräkningen
nollställs vid varje träff. En skylt som lästes för en sekund sedan är fortfarande
en skylt även när nästa bildruta är suddig.

Formatvalideringen (`normaliseraPlat`) står kvar bakom allt det här och är sista
skyddet. Men låset ska inte heller sitta kvar på något som aldrig läses.

## Mätning

Körs i `ocr-test.html`. De tio ursprungliga fallen ligger kvar oförändrade och
mäter samma sak som förut.

| | Före | Efter |
|---|---|---|
| Rå bild rakt in i motorn | 6 av 10 | 6 av 10 |
| Pipeline (fast siktruta mitt i bilden) | 8 av 10 | 8 av 10 |
| Målsökning (skylten var som helst) | fanns inte | 5 av 5 |

De två fall som fortfarande faller är desamma som förut: den smutsiga skylten
läses som JHD356 i stället för JHD556, och värsta fallet (200 px skylt, 12°
lutning, oskärpa och smuts samtidigt) ger ingen giltig läsning alls.

### Målsökningens fem fall

| Fall | Lås vid bildruta | Läst |
|---|---|---|
| Skylten uppe i högra hörnet | 8 | ABC123 |
| Skylten nere till vänster | 8 | RTN881 |
| Nedre halvan (hållarvinkel) | 8 | MLK907 |
| Två bilar — den mitt i vägen ska vinna | 8 | XKF42B (den centrala, vid lika storlek) |
| Vit skåpbilsdörr | låste aldrig | — |

Låset släpper också som det ska: 4 bildrutor efter att målet försvann ur bild
(tak 3), och efter 3 misslyckade läsningar när målet finns kvar men inte går att
läsa — och det låser sig då inte om på samma sak igen.

### Kostnad

Sökning i en bildruta på 1920 × 1080, median över 25 körningar:

| Arbetsbredd | Tid |
|---|---|
| 320 px | 4,4 ms |
| 400 px (vald) | 5,0 ms |
| 480 px | 5,7 ms |
| 960 px | 13,5 ms |

Mot en riktig videoström (1280 × 720, direkt från ett `<video>`-element) är
medianen 2,5 ms vid arbetsbredd 400, värsta uppmätta värde 12 ms. Åtta sökningar
i sekunden kostar alltså i storleksordningen 20 ms per sekund.

Full upplösning söks aldrig. Det kostar tre gånger mer och hittar inget mer — en
skylt som inte syns i 400 pixlars bredd är ändå för liten för att bli text.

## Autozoom

Autozoomen styr fortfarande på hur stor skylten är, nu mätt på det låsta målet i
stället för på vad som råkade ligga i mittrutan. Ett tak tillkom: zoomen
förstorar kring bildens mitt, men målet ligger sällan i mitten. Utan taket zoomar
den in tills skylten glider ut ur bild, tappar låset, zoomar ut, hittar den igen
och pumpar fram och tillbaka utan att någonsin stå still länge nog för en
läsning. Det syntes direkt i mätningen: en skylt nere till vänster hamnade
halvvägs utanför utsnittet vid 1,4×. Med taket stannar zoomen på 1,2× och målet
ligger kvar i bild.

## Ljud

Inget. Låset ger ingen signal. Bilkörning är inte ett dataspel, och ett pip per
lås hade pipit hela vägen till jobbet. Pipet vid en bekräftad skylt är oförändrat
och styrs som förut av inställningen `pip`.

## Att rita siktet

Modulen ritar ett eget sikte som standard. Sätt `ritaSikte: false` i
inställningarna så ritas bara videobilden, och rita själv utifrån
`kandidater`-händelsen (eller `reader.siktdata()`, som ger samma sak när som
helst).

```js
reader.addEventListener('kandidater', e => {
  const { kandidater, last, video, canvas, utsnitt, sokMs, lasKrav } = e.detail;
});
```

Varje kandidat:

| Fält | Betydelse |
|---|---|
| `id` | Spårets identitet. Samma id = samma fysiska skylt mellan bildrutor. |
| `x, y, w, h` | Rutan i **videons** pixlar — det koordinatsystem OCR:en arbetar i. |
| `canvas` | `{x, y, w, h}` — samma ruta i **canvasens** pixlar, färdig att rita. |
| `poang` | Rangordningen, 0–1. |
| `traffar` | Antal bildrutor i rad kandidaten setts. |
| `mognad` | `traffar / lasKrav`, klippt till 1. Fyll en mätare med den. |
| `tappade` | Antal bildrutor i rad den saknats. |
| `brand` | true = har lästs utan resultat och kan inte låsas. Rita den inte. |
| `last` | true för den låsta. `last` på översta nivån är samma objekt, eller null. |

De två koordinatsystemen skiljer sig så fort digital zoom är påslagen —
`utsnitt` är den del av videon som visas, och `canvas` är den utskalad över hela
duken. Att blanda ihop dem ritar siktet på fel ställe. Använd `k.canvas` när du
ritar i `reader.canvas`, och `k.x/y/w/h` om du ska mata tillbaka något till
modulen.

Så här ser modulens eget sikte ut, om du vill ha samma:

* kandidater med `traffar >= 2` och utan `brand`: tunn ljusblå ruta, plus en
  mätare under rutan med bredden `w * mognad`
* den låsta: fyra gröna hörnvinklar med armlängd 45 % av kortsidan, inga
  heldragna sidor — en sluten ruta ser ut som en knapp, hörnvinklar ser ut som
  ett sikte
* ingen dämpad ram runt bilden. Den sa "lägg skylten här", och det är precis
  kravet som togs bort.

Statustexterna följer med: `Söker skylt…`, `Låser på skylt…`,
`Låst på skylt — läser…`, och `Ser ABC 123 — bekräftar…` när en läsning väntar på
sin andra röst. De skickas bara när texten faktiskt ändras.

## Vad som fortfarande inte fungerar

* **Ett klistermärke med text på** går inte att skilja från en skylt före
  läsningen. Tecken-testet ser tecken. Det är formatvalideringen och kravet på
  två överens läsningar som fångar det, och först efter tre bomläsningar släpper
  låset.
* **Två skyltar som överlappar i bild** blir ett enda ljust område med fel kvot
  och sorteras bort. Ovanligt, men det händer i tät kö sett snett.
* **Mycket mörka skyltar** (kraftig motljus, natt utan gatlyse) hittas inte alls
  av sökningen — den bygger på att skylten är ljusare än sin omgivning. Där
  hjälper bara mittfallbacken, som läser mitten när målsökningen är tom i tre
  sekunder.
* **Bildrutetakten är inte garanterad.** Ligger fliken i bakgrunden stryps
  `setInterval` till en gång i sekunden av webbläsaren, och då tar låset åtta
  sekunder i stället för en. Det gäller redan inspelningen och läsningen sedan
  tidigare; skärmen ska vara på.
