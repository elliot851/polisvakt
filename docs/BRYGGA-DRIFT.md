# Bryggan i drift

Hur man ser att Polisvakts brygga lever, vad varje tillstånd betyder, och
exakt vad man gör vid varje fel.

Bryggan är det som gör att en polisvarning i Facebookgruppen hamnar på
kartan och i telefonen. Ligger den nere händer ingenting — men *det syns
inte*. Det finns inget felmeddelande, ingen tom skärm, ingen 500. Appen
ser precis lika glad ut. Det enda som saknas är varningar som aldrig kom,
och den saknaden märker bara den som inte fick sin.

Därför den här filen.

---

## 1. Snabbsvaret: lever bryggan?

```
powershell -NoProfile -File tools\brygg-diag.ps1
```

En skärmbild med sju rubriker och en sammanfattande rad längst ner:
**GRÖN**, **GUL** eller **RÖD**. Den läser bara — den startar ingenting,
stoppar ingenting och skriver ingen fil. Säker att köra mitt under skarp
drift.

Exitkoden går att kedja: `0` = grön, `1` = gul, `2` = röd.

Går du utan uppkoppling: `-IngenNat` hoppar över Supabase-anropet.

**Titta aldrig bara i Aktivitetshanteraren.** Att `powershell.exe` finns
i listan bevisar ingenting. Det var precis det felslutet som gjorde att
bryggan låg död i sexton timmar den 5 september 2026 — se avsnitt 8.

---

## 2. Vad kedjan består av

```
  Autostart-mappen  (vid inloggning, en gång)
        |
        +--> brygg-daemon.ps1 ......... läser gruppen, skriver rapporter
        |         |
        |         +--> Chrome med --remote-debugging-port=9222
        |         |         (egen profil, en flik per grupp)
        |         |
        |         +--> Supabase REST ... rapport + push till luren
        |
        +--> brygg-vakt.ps1 -Loop ..... vakthund, kollar var 60:e sekund

  Schemaläggaren (dagligen)
        +--> supabase-keepalive.ps1 ... hindrar att projektet pausas
```

Autostart-filen ligger i

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Polisvakt-brygga.cmd
```

och startar **både** daemonen och vakten. Den ligger där och inte i
Schemaläggaren av ett mätt skäl: en process som Schemaläggaren skapar ger
tysta barn. Daemonen startar, lever, drar CPU — och skriver inte en enda
rad, inte ens sin egen STARTrad. Tystnaden ärvs nedåt, så varken
`Start-Process` eller `cmd /c start` från en schemalagd förälder räddar
barnet. Autostart-mappen startas av Utforskaren i den vanliga
interaktiva sessionen, och den vägen både startar och loggar.

Följden av det valet, som är viktig att förstå: **hela kedjan lever i din
inloggade session.** Loggar du ut, startar om datorn eller stänger de två
minimerade konsolfönstren så dör allt tills du loggar in igen.

De schemalagda uppgifterna `Polisvakt-brygga` och `Polisvakt-vakt` finns
kvar men är **Disabled**, just av tystnadsskälet ovan. Slå inte på dem.

---

## 3. Loggarna

| Fil | Vad den innehåller |
|---|---|
| `%LOCALAPPDATA%\Polisvakt\brygg-daemon-<datum>.log` | Daemonens allt. En ny fil per dygn. |
| `%LOCALAPPDATA%\Polisvakt\brygg-vakt.log` | Vaktens beslut. **En rad per kontroll**, även när allt är bra. |
| `%LOCALAPPDATA%\Polisvakt\brygg-vakt-tillstand.json` | Backoff-räknaren. Överlever omstart. |
| `%LOCALAPPDATA%\Polisvakt\supabase-keepalive.log` | Daglig pingning av backend. |

Alla skrivs som UTF-8 **med** byte-order-märke, så `type` och
`Get-Content` visar å/ä/ö rätt utan flaggor. Windows PowerShell 5.1 läser
en BOM-lös fil som ANSI — glömmer man märket blir "loopläge" till
"looplÃ¤ge". Det syns fortfarande i gamla rader överst i `brygg-vakt.log`,
från innan `brygg-vakt.ps1` fick sin BOM.

### De två tal som betyder något

Diagnosen och vakten mäter samma två saker, och skillnaden mellan dem är
hela poängen:

- **Sista raden i daemonloggen.** Bevisar att processen kör kod. En frisk
  daemon skriver var tjugonde sekund. En som väntar på bryggfönstret
  skriver `VÄNTAR` var femtiofemte. Tystnad längre än **5 minuter** är
  hängläge.
- **Sista `SVEP`- eller `SUMMA`-raden.** Bevisar att den faktiskt *läser
  gruppen*. En daemon kan skriva `VÄNTAR` i timmar utan att ha sett en
  enda rad ur Facebook. Vaken är inte samma sak som seende. Utan svep på
  **15 minuter** räknas den som blind.

---

## 4. Tillstånden, och vad de betyder

### GRÖN

Processen lever, loggen är färsk, ett svep har gått nyligen, backend
svarar. Ingenting att göra.

### GUL

Fungerar, men något är inte som det ska. Vanligast:

| Gul rad | Betyder | Gör så här |
|---|---|---|
| `ingen flik står på en facebook.com/groups/<id>` | Bryggfönstret är uppe men gruppfliken saknas. | Vänta ett svep. Daemonen öppnar den själv med `/json/new`. Kvarstår det: se "Utloggad" nedan. |
| `sveper, men ingen lyssnare på 9222` | Bryggfönstret håller på att komma upp. | Vänta två minuter, kör diagnosen igen. |
| `daemonen skriver men har inte svept en enda gång ännu` | Den startade nyss. | Vänta en minut. |
| `TORRKÖRNING — vakten loggar vad den skulle gjort men startar ingenting` | Vaktens skyddsläge är på. **Det är läget just nu.** | Se avsnitt 6. |
| `antal processer: 2 daemoner matchar` | Dubbelstart. Mutexen brukar stoppa nummer två. | Kolla `brygg-daemon-<datum>.log` efter raden `En brygg-daemon kör redan`. Är den där är allt lugnt. |

### RÖD

Något är sönder och varningar kommer inte fram. Se nästa avsnitt.

---

## 5. Fel för fel — exakt vad man gör

### `processen finns inte. Bryggan kör inte.`

Daemonen är död eller har aldrig startat.

1. Kör diagnosen och kolla punkt 7 först — har `brygg-tillagg\brygga.js`
   glidit isär från `fb-bridge.user.js` **vägrar daemonen starta**, och
   varje omstartsförsök dör på samma rad. Synka först i så fall.
2. Starta om via Autostart-filen — dubbelklicka på
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Polisvakt-brygga.cmd`.
   Det är samma väg som vid inloggning, och den vägen loggar bevisligen.
3. Kör diagnosen igen efter en minut. Punkt 3 ska visa en färsk rad.

### `processen lever men loggen har tigit i N min — hängläge, inte drift`

Det farliga läget. Processen finns i Aktivitetshanteraren, den drar
kanske till och med CPU, och den gör ingenting.

1. **Stoppa processen först.** Daemonen håller den namngivna mutexen
   `Global\Polisvakt-Brygga` så länge den lever. Startar du en ny utan
   att döda den gamla säger den nya bara *"En brygg-daemon kör redan på
   den här maskinen"* och avslutar — omstarten *ser ut* att lyckas och
   ingenting har hänt.

   ```
   Stop-Process -Id <pid ur diagnosen> -Force
   ```
2. Starta om via Autostart-filen.
3. Vakten gör exakt det här själv när torrkörningen är avslagen.

### `daemonen skriver men har inte svept på N min — vaken men blind`

Loggen rullar (oftast `VÄNTAR`-rader) men ingen `SVEP`-rad kommer.

1. Kolla punkt 2 i diagnosen. Svarar inte port 9222 är bryggfönstret
   nere — se nästa post.
2. Svarar porten men ingen flik står på gruppen: kolla om Facebook är
   utloggat, se nedan.
3. Annars: stoppa och starta om enligt hängläget ovan.

### `port 9222: ingen lyssnare. Bryggfönstret är inte igång.`

Chrome med felsökningsporten kör inte.

Daemonen försöker starta det själv, men **högst var tredje minut**, och
den vägrar om en annan Chrome redan kör mot samma profilmapp. Kör redan
en Chrome mot profilen skickar den nya processen bara adressen vidare och
avslutar — flaggorna, inklusive felsökningsporten, kastas. Det ser ut att
lyckas.

1. Stäng bryggans Chrome-fönster helt (det med Polisvakt-profilen,
   `%LOCALAPPDATA%\Polisvakt\chrome-brygga`).
2. Låt daemonen öppna det igen, eller starta om daemonen.
3. Kvarstår det: kontrollera att profilmappen inte har en kvarglömd
   `lockfile` efter en krasch.

### `en flik står på login/checkpoint — kontot är UTLOGGAT`   /   `loggen säger att sessionen är utloggad`

**Ingen omstart i världen lagar det här.** Starta inte om i loop — den
24 augusti öppnade daemonen hundratals flikar just på den här situationen
innan spärren kom in.

1. Ta fram bryggans Chrome-fönster.
2. Logga in på Facebook för hand.
3. Klart. Daemonen hittar gruppfliken av sig själv inom ett par svep.

Vakten känner igen det här och *undviker* med flit att starta om på det —
den flaggar gult och lämnar det till en människa.

### `REST svarar inte på DNS. Projektet är PAUSAT eller raderat.`

Supabase pausar ett gratisprojekt efter ungefär en veckas inaktivitet,
och då slutar subdomänen resolva. Hela appen dör tyst.

1. Logga in på supabase.com och tryck **Restore**. Det finns ingen väg
   runt det från maskinen — nyckel och migrationer är *inte* felet.
2. `tools\supabase-keepalive.ps1` går dagligen via Schemaläggaren och
   hindrar att det händer igen. Den kan inte väcka ett redan pausat
   projekt.

### `brygga.js har glidit isär från fb-bridge.user.js`

Kopian i `tools\brygg-tillagg\` är den Chrome faktiskt kör. Glider den
isär från källan vägrar daemonen starta — med flit, för annars läser
Chrome en annan parser än den daemonen tror.

```
copy /Y "tools\fb-bridge.user.js" "tools\brygg-tillagg\brygga.js"
```

Vakten gör det själv innan varje omstart (i skarpt läge).

### `ingen vakt kör. Dör bryggan nu är det ingen som märker det.`

1. Starta om via Autostart-filen — den startar både daemonen och vakten.
   Dubbelstart är ofarlig: både daemonen och vakten tar var sin namngiven
   mutex och nummer två säger ifrån och avslutar.

### `sista vaktraden är äldre än 10 minuter` fast en vaktprocess finns

Vakten skriver en rad vid varje kontroll, var sextionde sekund. Skriver
den inte är den fastlåst, inte lugn.

```
Stop-Process -Id <vaktens pid> -Force
```

sedan Autostart-filen igen.

---

## 6. Torrkörningen — PÅ just nu

`brygg-vakt.ps1` går i **torrkörning som standard**. Den mäter, bedömer
och loggar exakt vad den skulle gjort — och stannar där. Inget fönster
öppnas, ingen process stoppas, ingen Chrome startas.

Så ser det ut i `brygg-vakt.log`:

```
2026-09-06 08:10:13  RÖD   processen lever men loggen har tigit i 978.5 min (gräns 5) — hängläge, inte drift  [pid=61624  ...  läge=torr]
2026-09-06 08:10:13  TORR  TORRKÖRNING: skulle stoppat pid 61624 och startat om bryggan (...).
2026-09-06 08:10:13  TORR          Inget öppnades. Slå av torrkörningen med -Skarp, se filhuvudet i brygg-vakt.ps1.
```

### Så slår man av den

Tre vägar. Välj en.

**1. Ett enstaka skarpt körtillfälle**

```
powershell -NoProfile -File tools\brygg-vakt.ps1 -Skarp
```

**2. Permanent för loopen som startar vid inloggning** — lägg till
`-Skarp` sist på vaktens rad i

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Polisvakt-brygga.cmd
```

så att den lyder

```
start "Polisvakt-vakt" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "...\tools\brygg-vakt.ps1" -Loop -Skarp
```

**Det här är den som gäller för verklig drift.** Så länge `-Skarp` inte
står där startar vakten aldrig om bryggan, hur röd loggen än blir.

**3. Permanent i skriptet** — sätt

```powershell
$TORRKORNING_SOM_STANDARD = $false
```

i `tools\brygg-vakt.ps1` (raden ligger strax under `param`-blocket).
Då blir skarpt läge standard och `-Torrkor` behövs för att få tillbaka
torrkörningen.

`-Torrkor` vinner alltid över `-Skarp`. Det är med flit: en flagga för
mycket ska ge tystnad, inte fönster.

---

## 7. Så bedömer vakten, i klartext

Var sextionde sekund, en rad i loggen oavsett utfall:

| Iakttagelse | Bedömning | Vad den gör |
|---|---|---|
| Ingen process, ingen logg | RÖD | startar om (bryggan har aldrig kört här) |
| Ingen process | RÖD | startar om |
| Process finns, loggen tyst > 5 min | RÖD | **stoppar processen**, startar om |
| Loggen färsk, men Facebook utloggat | GUL | logga men rör ingenting — bara en människa kan laga det |
| Loggen färsk, inget svep ännu | GUL | väntar |
| Loggen färsk, inget svep > 15 min | RÖD | stoppar och startar om |
| Sveper, men ingen lyssnare på 9222 | GUL | väntar — fönstret är på väg upp |
| Allt ovan grönt | GRÖN | nollställer backoffen |

**Backoff.** Efter varje omstartsförsök väntar den 1, 2, 4, 8, 16, 32 och
sedan 60 minuter innan nästa. Räknaren nollställs så fort en kontroll
blir grön, och den ligger på disk så den överlever att vakten själv
startas om — det är just då den behövs.

**Enkelinstans.** Loopläget tar mutexen `Global\Polisvakt-Vakt`. Startas
en till säger den ifrån och avslutar. Utan den spärren startade bryggan
om två gånger på en minut den 5 september.

**Loggen trimmas** till de 3000 senaste raderna när den passerar 1 MB.
En rad per kontroll är priset för att kunna bevisa att vakten levde
klockan tre på natten, och det priset är värt att betala.

---

## 8. Vad som hände 5 september 2026

Bryggan dog 15:51:45 och låg död i sexton timmar. Vakten körde hela
tiden. Den sa ingenting.

```
15:50:11  datorn startade om
15:51:41  Autostart-mappen startade vakten (loopläge, var 60:e sekund)
15:51:42  Autostart-mappen startade daemonen
15:51:45  daemonen: "Felsökningsporten svarar inte på 127.0.0.1:9222.
          Bryggfönstret öppnas automatiskt, se nästa rad."
          — nästa rad kom aldrig. Anropet till Starta-Bryggfonstret
          returnerade aldrig. Processen levde vidare, tyst.
          (Funktionen räknar upp Chrome-processer och läser MainModule
          på dem, och det anropet kan blockera. 13 Chrome-processer
          körde på maskinen just då.)
16 h      ingenting, i BÅDA loggarna.
```

Fyra fel samverkade, och vart och ett räcker för att döda bevakningen:

1. **Fel mått.** Vakten räknade processer. En hängd daemon *är* en
   process. Kontrollen svarade "levande" var minut i sexton timmar.
2. **Tystnad som design.** Den gamla filen loggade med flit ingenting när
   allt var bra, för att hålla loggen läsbar. Följden: loggen kunde inte
   skilja *"vakten kollade, allt var bra"* från *"vakten är död sedan i
   förrgår"*.
3. **Ömsesidig bevakning som hänger ihop med sig själv.** Daemonen har
   `Kolla-Vaktens-Puls` som startar om vakten — men den körs från
   daemonens huvudloop. Hänger daemonen hänger också den kollen. Och
   vakten hade just godkänt den hängda daemonen. Båda vaktade varandra
   och båda tittade åt fel håll samtidigt.
4. **Ingen spärr och ingen backoff.** 15:45:18 och 15:46:22 startades
   bryggan om två gånger på en minut, av ett problem (utloggad Facebook)
   som en omstart aldrig kunnat laga.

Och en femte, som gjorde loggen halvläslig: `brygg-vakt.ps1` saknade BOM,
så PowerShell 5.1 läste källkoden som ANSI och skrev "looplÃ¤ge" i sin
egen logg.

Allt fem är åtgärdat i `tools\brygg-vakt.ps1` och synligt i
`tools\brygg-diag.ps1`.

---

## 9. Fällor som redan kostat en runda

- **Att räkna processer med `brygg-daemon` i kommandoraden räknar också
  frågan.** Söksträngen står i den frågande processens egen kommandorad.
  Filtret måste utesluta `CimInstance`. Det felet gav "levande" två
  kontroller i rad medan bryggan låg död.
- **`brygg-daemon-*.log` matchar också `brygg-daemon-slutmatning.log`,**
  en engångsmätning från augusti. Mönstret måste vara
  `brygg-daemon-????-??-??.log`, annars ser varje kontroll ut som att
  bryggan varit tyst i veckor.
- **`start` i cmd kräver en fönstertitel.** Utan `"Polisvakt-brygga"`
  tolkar cmd den citerade sökvägen som titel och startar ingenting alls.
- **Sökvägen måste citeras.** Repot ligger under `Claude code 2GNDTN` —
  två mellanslag.
- **Spara aldrig en `.ps1` i det här projektet utan BOM.** Se avsnitt 3.
- **Slå inte på de schemalagda uppgifterna.** Se avsnitt 2.
