# Chattens område

Chatten var ett enda rikstäckande rum. Skriver någon i Västerås att polisen
står vid Erikslund hjälper det ingen i Malmö, och tvärtom. Nu hör varje
meddelande hemma i en trakt.

Kort: varje meddelande får en **områdeskod** — numret på en ruta i ett grovt
rutnät, cirka 25 km. Klienten hämtar sin egen ruta plus de åtta omkringliggande.
Ingen exakt position lagras någonsin.

## Varför rutnät och inte län

**Länsgränser skär rakt genom vardagen.** Den som kör två kilometer in i
Uppsala län ska självklart se en varning från Västerås. Gränsen finns på en
karta, inte på vägen. Ett rutnät ger "nära mig", vilket är det som faktiskt
menas med "i Västmanland".

**Ingen nätverksslagning.** Att slå upp län ur en koordinat kräver ett anrop
eller en geometritabell per meddelande. Rutnätet kräver två divisioner.

**Integritet, och det är det tyngsta skälet.** Exakta koordinater per
chattmeddelande vore en karta över var en enskild person befunnit sig och när.
Sju dygn av sådana rader ger hemadress, arbetsplats och vilka kvällar personen
inte var hemma. Den kartan får inte finnas, för allt som finns kan begäras ut,
läcka eller missbrukas. Det säkraste sättet att inte läcka en logg är att aldrig
skapa den.

En ruta på cirka 25 km säger *trakten*, inte *platsen*. Hela Västerås med
förorter delar en och samma kod. Det räcker för att avgöra om ett meddelande
angår mig, och det räcker inte för att följa någon.

**Regeln, utskriven: lagra aldrig lat eller lon på ett chattmeddelande.** Det
finns ingen sådan kolumn och det ska inte tillkomma någon. Behöver något i
framtiden veta var ett meddelande kom ifrån är svaret rutan, inte punkten.

## Så räknas koden

```
latitudindex  = floor(lat / 0,25)     0,25 grad = cirka 27,8 km, överallt
longitudindex = floor(lon / 0,5)      0,5 grad  = cirka 31 km i Skåne
                                                  cirka 21 km i Kiruna
kod = "r" + latitudindex + "x" + longitudindex
```

| Plats | Position | Kod |
| --- | --- | --- |
| Västerås | 59,6099 / 16,5448 | `r238x33` |
| Hälla (4 km bort) | 59,6265 / 16,6100 | `r238x33` — samma ruta |
| Sala (35 km bort) | 59,9270 / 16,6050 | `r239x33` — grannruta |
| Örebro (100 km bort) | 59,2741 / 15,2066 | `r237x30` — utanför |
| Malmö | 55,6050 / 13,0038 | `r222x26` — långt utanför |

Fasta steg i grader gör grannrutorna till ren heltalsaddition. Att rutan blir
smalare långt norrut är medvetet och skadar ingen.

`floor`, inte `round`: golvning ger rutor med fasta kanter som ligger still.
Avrundning hade lagt rutgränsen mitt i rutan och gjort grannlogiken fel i
kanterna.

**Nio rutor, inte en.** Rutnätet är godtyckligt utlagt. Står man femtio meter
från en rutkant ligger halva "nära mig" i grannrutan. Med de åtta grannarna med
är det garanterade avståndet till kanten minst en hel ruta.

Räkningen finns på två ställen — `rutkod()` i `js/chatt.js` och
`chatt_rutkod()` i `supabase/chatt-omrade.sql`. De kan inte dela kod, men de
får inte gå isär. **Ändras stegen på ett ställe ska de ändras på det andra.**

## Utan GPS tystas ingen

Saknas position blir koden `null`, meddelandet märks "utan område" och visas för
alla. Klienten sätter `utanOmrade: true` på meddelandet och `UTAN_OMRADE_TEXT`
finns att visa bredvid.

Avvägningen: hellre att någon ser ett meddelande från fel del av landet än att
en förare skriver ut i tomma intet utan att förstå varför ingen svarar. Tystnad
är den dyraste utgången i den här appen.

Samma sak gäller åt läsarhållet: har klienten ingen egen ruta filtreras
ingenting alls, varken i frågan eller lokalt. Vet vi inte var vi är kan vi inte
påstå att något inte angår oss.

## Servern validerar, den härleder inte

Kravet är att rutan inte ska gå att förfalska till något som avslöjar mer.

Att låta servern **härleda** koden vore att låta klienten skicka lat och lon.
Då hade koordinaterna passerat PostgREST, legat i request-loggen och funnits i
minnet på en maskin utanför telefonen — precis den exponering hela
konstruktionen finns för att undvika. Att härleda hade alltså gjort
integriteten sämre, inte bättre.

Servern **validerar och normaliserar** i stället, i två led:

1. `chatt_rutkod_normalisera(text)` plockar ut exakt två heltal ur strängen,
   avvisar allt som inte har den formen, avvisar index utanför Norden och
   **bygger om strängen från heltalen**. Det som lagras är aldrig det klienten
   skickade, utan serverns egen sammansättning av två avgränsade tal.
2. Villkoret `chatt_omrade_form` kräver att kolumnen är lika med sin egen
   normalisering. Det gäller insert och update, det syns i schemat och det
   överlever att triggern skulle försvinna.

**Vad det köper:** fältet kan inte bära mer information än en ruta. Ingen kan
smyga in `r238x33 59.60991,16.54483`, en tidsstämpel eller ett spår-id i
kolumnen. Det är det verkliga hotet mot en positionskolumn — att den blir en
dold kanal för exakt position.

**Vad det inte köper:** servern kan inte veta om koden är *sann*. En klient kan
påstå att den står i Kiruna. Men det ger ingenting: den som ljuger ser en annan
trakts chatt, och den chatten var rikstäckande och öppen för alla inloggade
redan innan. Ingen rättighet vinns, och skrivbromsen i `chatt.sql` gäller
oförändrat. Att sätta koden till `null` och nå alla är samma sak som läget före
den här ändringen.

Ogiltig kod ger `null`, inte ett fel. Meddelandet går alltså igenom och märks
"utan område". Att avvisa hade tystat någon på grund av ett teknikfel.

## Filtret ligger på servern

```
GET /rest/v1/chatt_flode
  ?select=*&order=skapad_at.desc&limit=100
  &or=(omrade.in.(r237x32,...,r239x34),omrade.is.null)
```

Att hämta hela landet och sålla lokalt hade betytt att varje pollning drar hem
meddelanden från Malmö till Kiruna över mobildata som föraren betalar för, var
åttonde sekund.

Den lokala filtreringen i `meddelanden()` finns ändå, men bara som städning av
cachen: kör man från Västerås till Örebro ska Västeråsmeddelandena inte bli kvar
på skärmen fram till nästa fulla hämtning. Ett rutbyte tvingar dessutom fram en
full hämtning — den nya traktens äldre meddelanden finns inte i cachen och kommer
aldrig med i en inkrementell fråga.

## Vyn döljer fortfarande avsändaren

`chatt_flode` fick `omrade` och ingenting annat. Kolumnen `avsandare` är
fortfarande inte med, vyn körs fortfarande med ägarens rättigheter (inte
`security_invoker`) och inloggningskravet ligger kvar i vyn själv.

Efter migreringen ska vyn ha exakt sju kolumner: `id`, `skapad_at`, `text`,
`visningsnamn`, `omrade`, `avsandarnyckel`, `mitt`. Står `avsandare` med är
något allvarligt fel.

## Migreringen

`supabase/chatt-omrade.sql` körs **efter** `supabase/chatt.sql`, i Supabase SQL
Editor. Den går att köra om hur många gånger som helst och raderar inte en enda
rad. Befintliga meddelanden får `omrade = null`, alltså "utan område", och når
alla precis som förut.

Filen rör inte `chatt.sql`. Normaliseringen fick en **egen trigger med eget
namn** i stället för att bakas in i `chatt_innan_insert`, eftersom den
funktionen ägs av `chatt.sql` och skrivs över med `create or replace` varje gång
den filen körs. Två triggrar som inte känner till varandra är billigare än ett
beroende som går sönder utan att någon märker det.

Postgres kör `BEFORE INSERT`-triggrar i bokstavsordning på namnet:
`chatt_innan_insert_trg` först, `chatt_omrade_innan_insert_trg` efter. De rör
olika kolumner, så ordningen spelar ingen roll — men den är känd.

En fälla värd att komma ihåg: en funktion i ett `CHECK`-villkor körs som den som
gör insertet, och Postgres kontrollerar `EXECUTE`-rätten då. Därför är
`chatt_rutkod_normalisera` utdelad till `authenticated`. Utan det avvisas varje
meddelande med "permission denied for function".

En annan: skriv **aldrig** ett cron-uttryck inuti en SQL-blockkommentar. En
stjärna följd av ett snedstreck avslutar kommentaren mitt i raden och filen dör
på "syntax error at or near 5". `supabase/chatt-omrade.sql` använder därför bara
radkommentarer med två bindestreck, hela vägen.

## Att koppla in i gränssnittet

Inget i `js/app.js` behöver ändras för att det ska *fungera* — `chatt.notera(fix)`
matas redan med hela GPS-fixen och plockar rutan därifrån. Det som återstår är
att visa saken:

- Rubriken `#chattRum` i `index.html` säger fortfarande "Alla som kör med
  Polisvakt i Västmanland". Den bör i stället spegla `chatt.rutkod` — trakten,
  eller "Hela landet" när rutan är okänd.
- Meddelanden med `m.utanOmrade === true` bör märkas i `renderChatt()`, med
  `UTAN_OMRADE_TEXT` som text.

## Tester

`chatt-test.html` täcker rutnätet i tre grupper: att rutan räknas rätt, att
koden aldrig avslöjar en position, och vad som faktiskt når föraren. Bland annat
att Malmö inte ligger i Västerås grannrutor, att två hundra slumppositioner
inom en ruta ger exakt en kod, och att varken objektet i minnet eller cachen i
localStorage innehåller koordinater.
