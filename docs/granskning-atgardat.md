# Åtgärdat ur granskningen: A3, A5 och A10

Tre av de bekräftade felen i `docs/granskning-datavagar.md` är lagade. Den
här filen säger vad som ändrades, varför just den lösningen, vad som
medvetet lämnades, och vad som återstår i filer den här omgången inte fick
röra.

Varje påstående i granskningen kontrollerades i källan först. Rapporten var
skriven två veckor tidigare och kunde ha hunnit bli inaktuell — det hade den
inte. Alla tre stod kvar precis som beskrivet, bara med några radnummer
förskjutna (`bedomFlodet`-anropet låg på `app.js:1433`, inte `1396`).

---

## A3. En grupps rapporter gick ut publikt

**Vad som var fel.** Hela serversidan var byggd: `reports.group_id`, läsregel,
skrivregel, index, kaskad. Klienten skrev aldrig fältet. Läsregeln i
`supabase/grupper.sql` lyder `group_id is null or is_group_member(group_id)`
— en rad utan `group_id` är alltså publik per definition. Ett åkeri som trodde
att förarnas rapporter stannade internt fick varenda en utlagd över hela länet.
Det är ett integritetsfel, inte en saknad funktion: appen lovade något den
inte höll, och det syntes inte, för rapporten kom fram — den kom bara fram
till fel publik.

**Vad som ändrades.**

* `js/groups.js` fick ett val av var man rapporterar: `pv.groups.aktiv.v1`,
  läst med `aktivGruppId()` och satt med `setAktivGruppId()`, plus
  `aktivId` / `aktiv` / `setAktiv()` på `Groups`-instansen.
* `js/store.js` läser `aktivGruppId()` när en rapport skapas och skickar
  `group_id` i insertet.

**Varför modulen frågas i stället för att app.js skickar med ett id.** Ett
argument som ska med vid varje anropsställe är ett argument någon kommer att
glömma — och det var precis så här funktionen kunde stå färdig på servern utan
att en enda rapport någonsin bar ett `group_id`. Nu finns det inget
anropsställe kvar att glömma.

**Tre försiktighetsregler som följde med.**

* **null är utgångsläget.** Ingenting blir privat av en slump; en rapport blir
  det bara efter ett aktivt val.
* **Valet kontrolleras mot grupplistan vid varje läsning.** Har man lämnat
  gruppen faller det tillbaka på publikt. Alternativet vore att skicka ett
  `group_id` servern nekar — alltså att varningen tyst försvinner helt, vilket
  är värre än att den blir publik.
* **Hopslagningen på 250 m går inte över gränsen.** En rapport till åkeriet får
  inte bli en bekräftelse på någon annans publika rapport, och en grupprapport
  får inte svälja en publik — då blir hela länet utan varning för att en förare
  råkade stå på samma gata.

**Halvt kvar.** `reports_feed` lämnar inte ut `group_id`, så appen kan läsa
tillbaka rapporten men inte se vilken grupp den hör till. Skyddet fungerar ändå
— radsäkerheten sköter det, klienten ska inte filtrera — men appen kan inte
skriva "från Åkeriet" på en rad. `store.js` behåller därför sitt eget
`group_id` när servern svarar utan det. Se listan längst ner.

## A5. Facebook-bryggan graderades på tomma fält

**Vad som var fel.** Raden slutade vid `denials: 0`. Ingen `parser_confidence`,
ingen `fordrojning_s`, ingen `geokod`, ingen `geokod_typ` — trots att alla fyra
låg färdiga i samma funktion. `kvalitet.js` faller då tillbaka på `'okand'`,
vilket ger −0,15 i poäng och 1 200 m antagen radie. Telegram-bryggan, som
skrevs senare, gör allt detta rätt. Samma inlägg fick alltså olika behandling
beroende på vilken brygga det kom in genom.

**Vad som ändrades.** Radbyggandet är brutet ur `run()` till en exporterad
`byggRapport(parsed, hit, val)` — samma namn och samma form som i
`js/telegram.js`, och av samma skäl: raden är det enda i hela bryggan som är
värt att testa utan nät, och den låg tidigare inbakad mitt i en loop med
`fetch` i. Funktionen skriver de fyra fälten, och lämnar `gps_accuracy_m`,
`fart_kmh` och `geokod_radius_m` som okända.

`gissaGeokodTyp()` importeras från `telegram.js` i stället för att kopieras.
Två ordlistor som ska betyda samma sak glider isär första gången någon lägger
till "avfart" på det ena stället, och `facebook.js` egen ingress säger redan
varför: reglerna ska bo på ett ställe.

**Nollor är inte okänt.** `gps_accuracy_m: 0` hade betytt "perfekt noggrannhet,
stillastående" och gjort ett främmande inlägg till den säkraste rapporten i
hela flödet. Fälten utelämnas i stället, vilket ger NULL i databasen. Samma
sopning tar hand om det andra problemet: `PostgREST` avvisar hela insertet om
en kolumn inte finns än, och en varning på kartan är viktigare än metadatan om
den.

**Vad det ger, mätt.** En färsk rapport om en gatuadress, geokodad via
nominatim:

| | poäng | osäkerhet | behandling |
|---|---|---|---|
| utan fälten (som förut) | 0,32 | 1 200 m | tyst |
| med fälten | 0,44 | 40 m | tyst |
| bekräftad av en till, utan fälten | 0,57 | 1 200 m | **tyst** |
| bekräftad av en till, med fälten | 0,69 | 40 m | **hedga** |

Den fjärde raden är hela skadan. Poängen 0,57 räcker gott och väl över
hedgningsgränsen 0,48 — men 1 200 m osäkerhet slår i regeln "en punkt över en
kilometer går inte att peka ut", och nivån dras ner till "syns på kartan, sägs
aldrig". Två personer sa samma sak och föraren fick inte höra det.

**Försiktigare, inte tystare.** `BAS_KALLA.facebook` är 0,42 mot appens 0,62,
och det ska den vara: en främlings mening i ett flöde är andrahandsuppgifter
och väger mindre än ett tryck i den egna bilen. Fixen rör inte den
avvägningen — den ser bara till att resten graderas på verklig data. Ett test
vaktar att den inte svänger över åt andra hållet.

## A10. Rapportörshistoriken var död kod — den är borta

**Vad som var fel.** `bedomRapport()` slog upp rapportörens tidigare
träffsäkerhet i en kontextnyckel som det enda anropsstället i hela appen aldrig
skickade. Blocket kördes aldrig, en enda gång, sedan det skrevs.

**Varför den inte gick att mata i stället.** Två oberoende hinder, och båda står
kvar:

1. Uppslagningen behövde `rapport.device_id`. Det publika flödet lämnar med
   flit inte ut det fältet (`supabase/dolj-enhets-id.sql`), så varje rapport som
   hunnit ett varv över servern saknar det oavsett.
2. Det finns ingen datakälla. `public.report_history` innehåller med flit inte
   `device_id`, och att bygga en ny som gjorde det vore att lägga tillbaka
   precis den koppling mellan rapport och person som togs bort av
   integritetsskäl. Det är ett större beslut än en buggfix.

**Vad som ändrades.** Blocket är borta, tillsammans med `slaUppHistorik()`, de
tre `DEFAULTS`-nycklarna, taket på `'dalig-historik'` och de två flaggor bara
blocket satte. En kommentar på platsen säger vad som låg där, varför det inte
gick att köra, och i vilken ordning det ska tillbaka: först en källa, sedan
koden.

**Varför borttagning och inte utkommentering.** Kod som ser ut att göra något
den aldrig gör är sämre än båda alternativen. Nästa läsare tror att en illa
fungerande rapportör dämpas, och slutar leta efter varför hen inte gör det.

**En syskonbugg hittades på vägen.** `Kontext`-typedefen dokumenterade fältet
som om det togs emot. Den är nu uttömmande, och ett test läser den ur källan
och kräver att varje dokumenterad nyckel faktiskt läses av koden — annars är
fällan tillbaka, bara i jsdoc i stället för i en if-sats.

---

## Testerna

`test.html`: **69 tester före, 83 efter. Noll fel i båda.** (En hoppas alltid
över: fildelningen kräver ett riktigt filsystem.)

De 14 nya kördes mot den gamla koden för att bevisa att de mäter något:
**12 av 14 föll.** De två som inte gjorde det är vakter, inte bevis — "utan
vald grupp är rapporten publik" och typedef-testet passerade även före, och
finns för att hindra att det svänger åt fel håll i framtiden.

Övriga svep är opåverkade: `telegram-test.html` 42/42, `navigering-test.html`
84/84, `korvanor-test.html` 36/36, `notiser-test.html` 45/45.

**Kontraktstesterna läser kod, inte kommentarer.** `utanKommentarer()` i
`test.html` skalar bort både block- och radkommentarer innan något matchas. En
kommentar som förklarar en fix ska aldrig kunna få ett test att larma om den
fix den beskriver.

---

## Kvar att göra i filer den här omgången inte rörde

**`supabase/kvalitetsfalt.sql`** — lägg `group_id` i `reports_feed` och
grant:a kolumnen:

```sql
create or replace view public.reports_feed
with (security_invoker = on) as
  select
    id, type, lat, lon, label, note, source, external_id,
    created_at, expires_at, confirms, denials, removed, inserted_at,
    gps_accuracy_m, fart_kmh, fordrojning_s,
    geokod, geokod_typ, geokod_radius_m, parser_confidence,
    group_id
  from public.reports;

grant select (group_id) on public.reports to anon, authenticated;
```

Läsregeln släpper ändå bara igenom grupper man är med i, så kolumnen läcker
ingenting. Utan den kan appen inte säga vilken grupp en rapport kom från.

**`js/app.js`** — tre saker:

1. En väljare för var man rapporterar. `groups.setAktiv(id)` och
   `groups.aktiv` finns; det som fattas är en rad i gränssnittet och texten
   "du rapporterar till Åkeriet" när något är valt. Utan den kan ingen välja,
   och `group_id` blir null för alla — datavägen är lagad, men vägen dit går
   genom en knapp som inte finns än.
2. `bedomFlodet(..., { nu, minaId })` på rad 1433 skickar `minaId`, som
   `kvalitet.js` aldrig har läst. Exakt samma familj som A10, upptäckt när
   typedefen städades. Antingen tas nyckeln bort ur anropet, eller så ska
   någon faktiskt läsa den — men den ska inte stå kvar och se ut att göra
   något.
3. A2 ur granskningen står kvar och blockerar A3 i praktiken: `r.invite?.kod`
   läses inte, så ingen kan bjuda in någon till en grupp. En grupp man inte
   kan bli medlem i har inga rapporter att skydda.

**Inte lagat, med flit:**

* **A5:s systerfynd, B1** — `facebook.js` ber om `return=representation` mot
  en tabell som `dolj-enhets-id.sql` bara gett kolumnvis SELECT på. Faller
  varje insert på `permission denied` är kvalitetsfälten oviktiga. Går inte
  att avgöra utan ett anrop mot den skarpa databasen, precis som granskningen
  skriver. Prova med `curl` innan något skrivs om.
* **Klientens läsning av `group_id`** — kräver SQL:en ovan först.
* **B4, `GEOKOD_DELTA.alias`** — samma sort som A10 (ett värde ingen kan nå),
  men två poängs skillnad och en ändring i `geocode.js`, som inte ingick.

Produktreglerna är orörda: nykterhets- och drogkontroller annonseras aldrig,
fartkameror rapporteras inte av användare. Testerna som vaktar dem gick igenom
före och efter.

---

*Åtgärdat 2026-08-20. Ingenting committat.*
