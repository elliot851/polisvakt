# Kartan: rotation och kör-upp

Hur kartan vrids, hur kör-upp går på och av, vilken väg som valdes och vad den
kostar. Koden ligger i `js/kartrotation.js` (rotationen) och `js/map.js`
(kartan i övrigt).

---

## Kort version för den som bara ska köra bil

* **Vrid kartan** med två fingrar, precis som i Waze. Nyp för att zooma
  samtidigt — de bråkar inte med varandra.
* **Kompassknappen** dyker upp till höger så fort kartan inte längre ligger med
  norr uppåt. Ett tryck rätar upp den.
* **Kör-upp** är påslaget från början. När bilen rullar över 12 km/h vrider sig
  kartan så att färdriktningen är uppåt. "Varning till höger" betyder då samma
  sak på skärmen som genom vindrutan.
* **Håll in kompassen** för att slå av eller på kör-upp helt.

---

## Varför det här var svårt

Leaflet 1.9.4 kan inte rotera. Det finns ingen `map.setBearing()`, ingen dold
flagga. Rutnätet med kartbrickor utgår från att norr är uppåt, markörer placeras
i oroterade pixelkoordinater, och all matte från "föraren tryckte här på
skärmen" till "det där är den här positionen" antar samma sak.

Det fanns tre vägar. Alla tre kostar något.

### 1. Byta ut kartlagret mot en vektorkarta (MapLibre GL)

Roterar inbyggt, och — viktigast — kan rita gatunamnen upprätt oavsett hur
kartan ligger, eftersom texten sätts av klienten och inte är inbränd i bilderna.

Kostnaden är för hög här och nu: ~800 kB bibliotek som måste vendoras in i
repot, en ny brick-källa med egen prismodell eller egen server, en ny stilfil,
och `js/app.js` plus `css/app.css` skulle behöva skrivas om kring en annan
karta. WebGL drar dessutom batteri och GPU i en telefon som samtidigt spelar in
video och pratar. Det är rätt väg någon gång i framtiden, inte den här veckan.

### 2. Ta in ett rotationsplugin (leaflet-rotate)

Skriver om ett trettiotal privata Leaflet-metoder och är låst till exakt en
Leaflet-version. Får inte hämtas från CDN — service workern förhandscachar
appskalet och offline-läget ska hålla. Att vendora in ~40 kB kod som vi ändå
måste förstå och underhålla själva ger sämre kontroll än att skriva de fyra
lagningar vi faktiskt behöver.

### 3. Rotera med CSS och rätta till det som går sönder ← **vald väg**

Det som faktiskt går sönder är färre saker än man tror. Hela lagningen är runt
150 rader.

---

## Hur det fungerar

```
#map                        klipper, är exakt så stor som den syns
 └─ .pv-map                 Leafletbehållaren. ALDRIG roterad.
     │                      All skärmkoordinat-matte utgår från dess kant.
     ├─ .pv-rotor           roteras med transform: rotate()
     │   └─ .leaflet-map-pane   brickor, markörer, canvas
     └─ .leaflet-control-container   utanför rotorn → står alltid upprätt
```

**Förstoringen.** En roterad rektangel täcker inte längre skärmen — hörnen blir
tomma. Därför växer Leafletbehållaren till en kvadrat med skärmens diagonal som
sida, centrerad, medan `#map` klipper bort överskottet. Då *tror* Leaflet att
kartan är större än den syns och laddar brickor, dimensionerar canvas och
räknar pixelgränser för hela ytan. Allt som utgår från `map.getSize()` blir
därmed rätt av sig självt. Förstoringen slås bara på när kartan faktiskt är
vriden.

Förstoringen är exakt symmetrisk (`bredd + 2 × padding`), vilket gör att
`invalidateSize()` håller kvar samma mittpunkt och att rotationen sker kring
den synliga rutans mitt. Verifierat: en fast geografisk punkt ligger på exakt
samma skärmpixel före och efter att förstoringen slås på och av.

**De fyra lagningarna.**

1. `containerPointToLayerPoint` / `layerPointToContainerPoint` roteras kring
   behållarens mitt. Utan dem landar varje tryck på fel plats på kartan, och
   "peka ut plats" pekar ut fel gata. Allt annat i Leaflet — klick, popup,
   nypzoom, dubbelklickzoom, canvasens träffytor — är byggt ovanpå de två.
2. `Renderer._update` är den enda inbyggda som vill ha den **oroterade**
   omräkningen; den lägger ut en axelparallell canvasyta i lagerrymden. Får den
   roterade hörn hamnar ytan snett och cirklar (noggrannhetsringen,
   hotspots) klipps bort. Den körs därför med rotationen tillfälligt avstängd.
3. **Dragvektorn.** Leaflet lägger fingrets skärmvektor rakt på kartrutans
   position. I en roterad ruta betyder det att kartan glider snett i
   förhållande till fingret. Vektorn roteras tillbaka innan den används.
   Tröghetsutkastet efter släpp räknas på samma värden och blir rätt på köpet.
4. **`touchZoom = 'center'`** medan kartan är vriden. Leaflets nypzoom räknar en
   skärmvektor i projicerade koordinater och driver iväg när kartan är vriden.
   Zoom mot mitten är dessutom rätt beteende i bil, där bilen ligger i mitten.

---

## Gesten

Två fingrar, vrid. Lyssnarna är **passiva** och rör aldrig `preventDefault` —
Leaflets egen nypzoom och panorering fortsätter fungera exakt som förut. Vi
läser samma fingrar en gång till och lägger vridningen ovanpå.

* **Tröskel 12°.** En vanlig nypzoom vrider sig alltid några grader på vägen.
  Under tröskeln händer ingenting alls. Över den tar rotationen vid utan hopp,
  eftersom vinkeln nollställs mot nuläget i samma ögonblick.
* **Obegränsad vridning.** Vinkeln summeras per rörelse, så man kan snurra
  kartan hur många varv som helst utan att den slår runt.
* **Snäpp vid släpp.** Är kartan inom 5° från norr när fingrarna släpper åker
  den till norr. Ingen vill ha en karta som ligger tre grader snett.
* Att vrida manuellt sätter kartan i **manuellt läge** och pausar kör-upp.
  Föraren har sagt vad hen vill se; appen ska inte tjafsa emot.

---

## Vägen tillbaka till norr

Kompassknappen sitter till höger, ovanför Centrera-knappen, och syns **bara när
kartan inte ligger med norr uppåt** — samma regel som Waze. En roterad karta
utan väg hem är värre än ingen rotation alls.

* **Kort tryck:** kartan animeras till norr uppåt. Kör-upp pausas, för annars
  hade kartan snurrat tillbaka inom en sekund och knappen varit meningslös.
  Pausen släpper när bilen stått still (under 5 km/h) i en minut — nästa
  igångkörning är en ny körning.
* **Långt tryck (0,55 s):** slår av eller på kör-upp helt. Valet sparas i
  `localStorage` under nyckeln `pv.karta.v1`. En kort textremsa förklarar vad
  som hände.

Nålen i knappen pekar mot norr, så den visar också *hur* snett kartan ligger.
Ringen lyser blå när kör-upp är aktivt.

**Om kör-upp är avstängt och kartan ligger rakt norrut syns ingen knapp.** Vägen
tillbaka är då: vrid kartan med två fingrar så att knappen dyker upp, och håll
in den. Det är en medveten avvägning — kravet var att knappen bara får synas när
kartan är vriden, och inställningsvyn ägs av en annan del av koden.

---

## Kör-upp

Kursen kommer från `fix.headingSmoothed`, samma värde som varningsmotorn
använder. **Ingen andra kurskälla** — varken enhetens magnetometer eller
`deviceorientation`. Två källor som säger olika saker är värre än en osäker.

| Situation | Vad kartan gör |
|---|---|
| Under 12 km/h | Fryser i senaste riktningen |
| GPS-noggrannhet sämre än 60 m | Fryser i senaste riktningen |
| Kursändring under 3° | Ignoreras helt |
| Kursändring över 3° i minst 12 km/h | Kartan vrids mjukt dit |
| Manuellt vriden karta | Kör-upp rör ingenting förrän kompassen tryckts |
| Kompassen tryckt | Pausat tills bilen stått still i en minut |

**Varför trösklarna finns.** I rödljus, i kö och på parkeringen är GPS-kursen
ren gissning: telefonen rapporterar ofta ingen kurs alls under gångfart, och
positionsbruset ger slumpmässiga riktningar. Utan tröskeln snurrar kartan
vilt vid varje rödljus. Det är skillnaden mellan en karta man kan titta på och
en karta som gör en åksjuk. Vi fryser hellre en gammal riktning än visar en
påhittad ny.

Vridningen är mjukad med en exponentiell filtrering (tidskonstant 260 ms), så
en sväng ser ut som en sväng och inte som ett hopp.

**Bilen ligger 15 % under mitten** i kör-upp, som i Waze. Det man behöver se är
vägen framåt, inte den man just kört. Förskjutningen räknas om i kartans
roterade rymd, så bilen hamnar rakt under mitten på skärmen oavsett riktning.

---

## Det som ritas på kartan står upprätt

En roterad karta med upp-och-nedvända markörer är obrukbar. Följande vänds
tillbaka:

* rapportmarkörernas symboler (ringen runt är rund och bryr sig inte)
* platsnålen — vrids kring sin egen spets så den fortsätter peka på rätt punkt
* popup-bubblor, inklusive spetsen: bubblan vrids kring sin nederkant och
  spetsen kring sin överkant, vilket är samma punkt, så hela bubblan vrids
  stelt kring sin ankarpunkt

Hastighetsskylten, hastighetssiffran, varningsbannern och alla knappar ligger
utanför kartan i vanlig HTML och påverkas överhuvudtaget inte. Zoomknapparna
och upphovsrättsraden ligger utanför rotorn och står därför alltid rätt.

Riktningspilen för egen position vänds med flit **inte** tillbaka. Den ritas i
kartans egen rymd, så vridningen räknas bort av sig själv: pilen pekar rätt på
skärmen utan extra arbete, och i kör-upp pekar den alltid rakt upp — precis som
den ska.

---

## Vad det kostar

Rotation får inte orsaka löpande omflödning i en telefon som samtidigt spelar in
video och pratar. Det gör den inte heller:

* **En stilskrivning per bildruta.** Vinkeln skrivs som två nedärvda
  CSS-variabler på ett gemensamt förfaderelement. Rotorn läser den ena, allt som
  ska stå upprätt läser den andra. Ingen loop över markörer, ingen ikon byggs
  om, ingen `setIcon()`. Bara `transform` — aldrig något som utlöser layout.
* **Markörernas motrotation kvantiseras till hela grader.** En grad är osynlig
  på en 38 px ikon och sparar en stilomräkning per bildruta. Själva kartan
  vrids i tiondels grad.
* **Kompositorlagret (`will-change: transform`) läggs bara på medan rotationen
  rör sig** och släpps 400 ms efter att den stannat. Ett permanent lager över
  hela kartan kostar minne som dashcam-inspelningen behöver bättre.
* **Kör-upp uppdaterar sällan.** Dödbandet på 3° gör att rak landsväg inte rör
  kartan alls. Bara i svängar går animationen igång, i ungefär en halv sekund.

Den verkliga kostnaden ligger i **brickorna**: den förstorade kvadraten är
2,4–2,7 gånger så stor som skärmen (på en 390 × 844-telefon blir den
930 × 930), och så många fler brickor laddas och hålls i minnet medan kartan är
vriden. Det mildras med `keepBuffer: 1` i stället för 2 så länge förstoringen är
på, men det försvinner inte. Kör man alltid med norr uppåt betalar man
ingenting — förstoringen slås på först när kartan faktiskt vrids.

När förstoringen slås på och av sker **en** omflödning av kartrutan
(`invalidateSize`). Det händer vid gestens tröskel och när man återvänder till
norr, alltså vid en medveten handling — aldrig löpande.

---

## Känt som inte fungerar

* **Gatunamnen i brickorna vrider sig med kartan.** De är inbrända i bilderna;
  ingen CSS i världen kan räta upp dem. Kör man söderut står gatunamnen upp och
  ner. Det är den stora kostnaden för den valda vägen och den enda riktiga
  fixen är en vektorkarta (väg 1 ovan). Vill man hellre ha en karta helt utan
  text finns CARTO:s `dark_nolabels` / `voyager_nolabels` som ett enradsbyte i
  `TILES` i `js/map.js`.
* **Popupens stängkryss göms medan kartan är vriden.** Det sitter absolut
  placerat i bubblans oroterade hörn och följer inte med när bubblan vrids. Ett
  tryck på kartan stänger bubblan som vanligt.
* **Popupens autopanorering är avstängd medan kartan är vriden.** Den räknar i
  oroterade pixlar och skulle dra kartan mot den dolda ytan utanför skärmen.
  En bubbla nära kanten panoreras alltså inte in i bild.
* **Nypzoom zoomar mot kartans mitt, inte mot fingrarna, medan kartan är
  vriden.** Se lagning 4 ovan. I bil är det rätt beteende ändå, eftersom bilen
  ligger i mitten.
* **`map.getBounds()` returnerar den förstorade kvadratens hörn**, inte den
  synliga rutans. Det är en övermängd — säkert för "vad finns i närheten", fel
  för exakta kantberäkningar. Ingen kod i appen använder det i dag.
* **Ingen rotation med mus eller tangentbord.** Gesten är tvåfingersvridning.
  För felsökning finns `map.setBearing(grader)` och `map.northUp()` på
  `HazardMap`.
* **Kartbrickorna får en pixels överlapp** (`width: 257px`) medan kartan är
  vriden, för att dölja de hårfina sömmar som subpixelavrundning i en roterad
  transform annars ger. Bildinnehållet sträcks 0,4 % — osynligt, och markörernas
  geometri påverkas inte.

---

## Att göra vid nästa utrullning

`js/kartrotation.js` är en ny fil och står **inte** i `SHELL`-listan i `sw.js`
(den filen ägs av någon annan). Den fungerar ändå — service workern cachar alla
lyckade förfrågningar mot egen domän när de hämtas — men den bör läggas in i
listan så att den förhandscachas som resten av appskalet:

```js
  './js/map.js',
  './js/kartrotation.js',   // ← lägg till
```
