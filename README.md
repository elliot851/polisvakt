# Polisvakt Västmanland

Varnar för fartkameror och polis medan du kör. Karta, röstvarningar på svenska,
röststyrd rapportering och dashcam. Byggd som en hemsida som läggs på
hemskärmen — ingen App Store, inget godkännande, uppdateringar går live direkt.

---

## Kom igång på fem minuter

**1. Testa lokalt**

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Öppna <http://localhost:8080>. Servern är ett PowerShell-skript som använder
.NET som redan finns i Windows — inget Node, inget npm.

**2. Lägg upp den så mobilen kommer åt den**

GPS, mikrofon och kamera kräver **https**. Över vanlig http fungerar de bara på
`localhost`, så appen måste ligga på en riktig adress för att testas i bilen.
Dra och släpp hela mappen på <https://app.netlify.com/drop> — det tar tio
sekunder och kostar ingenting. Vercel och GitHub Pages fungerar likadant.

**3. Hämta fartkamerorna**

Öppna `tools/import-cameras.html`, skaffa en gratisnyckel på
<https://data.trafikverket.se/>, hämta och lägg den nedladdade filen i
`data/cameras.json`. Utan det steget varnar appen för polis men inte för
kameror.

**4. Slå på delning mellan användare**

Skapa ett gratisprojekt på <https://supabase.com>, kör
`supabase/schema.sql` i SQL-editorn, och klistra in projektets URL och
anon-nyckel under **Inställningar → Delning**. Utan detta fungerar allt, men
rapporterna stannar på din egen telefon.

---

## Vad appen gör

**Fartkameror.** Varnar riktat: bara om du faktiskt kör mot kameran, och en
gång per passage. Framförhållningen skalas med hastigheten — i 110 km/h kommer
varningen längre bort än i 50, så att du hinner sakta ner i tid.

**Polis och kontroller.** Områdesvarning inom 1,5 km (justerbart). Rapporter
lever 30–60 minuter beroende på typ, och förlängs när någon bekräftar dem.
Tre nedröstningar tar bort en rapport.

**Rösten.** Varningarna läses upp på svenska: *"Varning. Polis vid Dillos, om
1,2 kilometer klockan 12, rapporterat för 4 minuter sedan."* Klockslaget är
riktningen relativt färdriktningen — klockan 12 är rakt fram.

**Röststyrning.** Säg **"Hej vakt"** följt av kommandot, utan att röra
telefonen:

| Du säger | Vad som händer |
|---|---|
| "polis vid Dillos" | Rapport skapas vid Dillos |
| "polis här" | Rapport på din GPS-position |
| "fartkamera vid Erikslund" | Kamerarapport |
| "nykterhetskontroll Hälla" | Kontrollrapport |
| "civilbil här" | Civil polisbil på din position |
| "polisen är borta" | Närmaste rapport markeras som borta |
| "tyst" | Tystar varningar i 15 minuter |

**Dashcam.** Bakkameran filmar framåt genom vindrutan, frontkameran filmar
kupén som bild-i-bild, ljudet spelas in. Digital zoom på båda, stående eller
liggande, tid och hastighet inbränt i bilden. Spelar in i loop och raderar det
äldsta automatiskt. Händer något — tryck **Spara händelse**, så låses
klippen runt den tidpunkten och överlever loopen.

---

## Att veta innan du släpper den till andra

Det här är saker som kommer att dyka upp, så det är bättre att veta om dem nu.

**Facebook-gruppen går inte att läsa via API.** Meta stängde Groups API för
inläggsläsning 2024. Det finns ingen laglig endpoint som prenumererar på en
grupps flöde. Tre vägar framåt, sämst först:

1. `tools/fb-bridge.user.js` — ett användarskript (Tampermonkey) som läser
   inläggen du redan ser i din egen inloggade webbläsare och skickar de som
   ser ut som polisvarningar vidare. Fungerar direkt, men kräver att fliken är
   öppen och strider mot Metas villkor. Risken ligger på kontot som kör det.
   Står i torrkörningsläge från början — sätt `dryRun: false` när du testat.
2. **Be gruppens admin spegla inläggen till en Telegram-kanal.** Telegram har
   ett riktigt bot-API som får läsa. Samma parser, ingen villkorsrisk,
   fungerar dygnet runt utan öppen flik. Det här är den hållbara vägen.
3. **Låt appen bli kanalen.** Rapportknapparna och rösten är snabbare än att
   skriva i en grupp under körning. Får du folk att rapportera i appen behövs
   Facebook inte alls.

Parsern och ingesten är byggda så att alla tre vägar matar in på samma ställe
(`window.polisvakt.ingest`), så du kan byta utan att röra resten.

**Röstigenkänning saknas på iPhone.** Safari har ingen `SpeechRecognition`.
Väckningsordet fungerar därför bara på Android/Chrome. På iPhone finns
tryck-och-tala-knappen istället, och uppläsningen av varningar fungerar som
vanligt. Appen säger detta rakt ut i installationsguiden istället för att låta
funktionen se trasig ut.

**Appen måste ligga i förgrunden.** Webbläsare stoppar GPS, mikrofon och kamera
när appen hamnar i bakgrunden eller skärmen släcks. Wake Lock håller skärmen
tänd, men telefonen måste sitta i en hållare med appen framme. Det är den
enskilt största skillnaden mot en riktig native-app, och den går inte att
koda sig runt.

**Betalspärren går att kringgå.** En spärr som bara finns i klienten stoppar
inte den som verkligen vill. Provperiodens start sparas därför även i
Supabase, kopplad till enhetens id, så att en rensad webbläsare inte ger fem
nya dagar. Riktig kontroll kräver inloggning — se nedan.

**Vägnamn utan korsning blir oprecisa.** "Polis på E18" landar på en punkt
någonstans på E18. Uppmuntra folk att säga en plats: "E18 vid Hälla".

**Rapporter är gissningar.** Användargenererad data är färskvara. Appen visar
alltid hur gammal en rapport är, och läser upp det, så att föraren kan värdera
den själv.

---

## Prenumeration

5 dagar gratis, sedan 29 kr/mån. Provperioden startar först när appen används
på riktigt, inte vid första sidladdningen. Betalväggen visas aldrig under
körning — den väntar tills bilen står still.

**Sälja innan Stripe är på plats:** generera koder i Supabase, sälj via Swish,
kunden löser in koden under Inställningar.

```sql
insert into access_codes (code, months)
select 'PV' || upper(substr(md5(random()::text), 1, 6)), 1
from generate_series(1, 20)
returning code;
```

**Med Stripe:** skapa en Payment Link på 29 kr/mån och klistra in URL:en i
`js/app.js` under `defaults.paymentLink`. Appen skickar med enhetens id som
`client_reference_id`. Sedan behövs en webhook som sätter `paid_until` i
`subscribers` — det är den enda serverkod projektet kräver, och den kan ligga
som en Supabase Edge Function.

---

## Filer

```
index.html              Gränssnittet
css/app.css             Mörkt tema, stora träffytor
js/app.js               Sammanfogning av allt
js/parser.js            Svensk text -> rapport. Ordbaserad, inte regex
js/alerts.js            Varningsmotorn: när och vad som ska sägas
js/geo.js               GPS, utjämnad kurs och hastighet
js/geocode.js           Platsnamn -> koordinater, med inlärning
js/store.js             Rapporter, lokalt eller delat via Supabase
js/voice.js             Uppläsning och röstigenkänning
js/map.js               Leaflet-kartan
js/dashcam.js           Inspelning, loopbuffert, klippbibliotek
js/billing.js           Provperiod och prenumeration
js/install.js           Installationsguide per telefontyp
data/aliases.*.json     Slang -> söksträng ("dillos" -> Dillos Pizzeria)
data/cameras.json       Fartkameror, fylls av importverktyget
tools/import-cameras.html   Hämtar Trafikverkets kameradata
tools/fb-bridge.user.js     Facebook-brygga (läs varningen ovan)
supabase/schema.sql     Tabeller, behörigheter och funktioner
serve.ps1               Lokal testserver
```

## Lär appen nya platser

Säger någon "polis vid Sjöhagen" och appen inte hittar dit, frågar den en gång
och föraren pekar på kartan. Därefter sitter platsen permanent. Vanliga
Västeråsplatser ligger redan i `data/aliases.vasteras.json` — fyll gärna på
den, det är bara en textfil.

## Krediter

Kartdata © OpenStreetMap-bidragsgivare, brickor © CARTO.
Kameradata © Trafikverket. Geokodning via Nominatim.
