# Bryggan utan ett Facebook-fönster på din dator

En utredning, inte en ändring. Ingen kod är rörd. Utredd 2026-09-06.

**Frågan:** hur får appen in inläggen från "Här står polisen — Västerås" utan
att din dator står på, utan att din Facebook-session hålls levande i ett
Chrome-fönster, och utan att någon (jag) uppdaterar en sida?

---

## Rekommendationen, i klartext

**Byt inte kedja. Byt bara det första ledet.**

Hela mejlvägen är redan byggd och ligger i repot: 3 143 rader SQL, en tolkare
på 1 287 rader JavaScript, två edge-funktioner, notisspärrar, avdubbling,
hälsovy. Den kör redan i molnet. **Precis en enda del av den kräver din
dator: `tools/fbmejl-hamta.ps1`, som läser postlådan över IMAP.** Allt efter
den punkten går redan på Supabase och bryr sig inte om huruvida du är hemma.

Så rekommendationen är:

> **Låt Facebook mejla en egen adress på en egen domän som ligger hos
> Cloudflare. En Email Worker tar emot mejlet i samma sekund det kommer och
> POSTar det till en ny liten edge-funktion, som lägger det i `fbmejl_ko`.
> Resten av kedjan är redan klar och orörd.**
>
> Ingen dator. Ingen webbläsare. Ingen inloggad session. Inget lösenord i
> loopen. Ingen pollning — mejlet knackar på självt. Kostnad: en domän,
> ungefär 130 kr om året. Allt annat är gratis.

Varför just den och inte IMAP-pollning från molnet: en **push** har ingen
fördröjning och ingen kredential som kan gå ut. Cloudflare kontrollerar
dessutom SPF/DKIM/DMARC **innan** din kod ens körs, vilket är exakt det
skyddet `docs/fbmejl.md` säger måste finnas vid brevlådan och som idag är
tänkt att lösas med en spamregel hos Strato.

Vill du inte röra DNS i dag finns en fallback som ger samma resultat med
sämre latens och ett lösenord i molnet — se **Väg 1a** längre ned. Nedströms
är de identiska, så valet går att ändra senare utan att röra något annat.

### Men två saker måste sägas rakt ut, direkt

**1. Mejlvägen tar bort beroendet av din DATOR, inte av ditt FACEBOOK-KONTO.**
Det är fortfarande ditt konto som är medlem i gruppen och ditt konto som får
notiserna. Det du sa var "vi kan ju inte vara beroende av min Facebook-profil,
att jag är inloggad på datorn och att du hela tiden uppdaterar Facebook-sidan".
Två av de tre försvinner helt. Den tredje — profilen — försvinner bara om
gruppens inlägg speglas till Telegram eller om medlemmarna rapporterar i appen
i stället. Ingen teknisk lösning tar bort profilen, och den som påstår något
annat säljer dig en skrapare.

**2. Facebook bestämmer hur mycket du får veta.** Det finns inget e-postval på
gruppnivå, och Facebook aviserar bara om inlägg algoritmen väljer. Dagens
skrapare ser *varje* inlägg. Mejlvägen ser *ett urval*, och urvalet är inte
ditt att styra. **Hur stort urvalet är vet ingen ännu — det är den enda
verkligt öppna frågan i hela det här dokumentet, och den avgör om
rekommendationen håller.** Därför börjar planen med en mätning som kostar
noll kronor och ett dygn.

---

## Vad som redan finns (och vad som faktiskt hänger på datorn)

```
   FACEBOOK                    DIN DATOR                    SUPABASE            TELEFONEN
      |                            |                            |                   |
 [ IDAG, skraparen ]               |                            |                   |
      |   Chrome --remote-debugging-port=9222                   |                   |
      |<-------------------------->|  tools/brygg-daemon.ps1    |                   |
      |   din inloggade session    |  5 620 rader               |                   |
      |                            |--- rpc/fbmejl_ta_emot ---->|                   |
      |                            |                            |---- push -------->|
      |                            |                            |                   |
 [ MEJLVÄGEN, redan byggd ]        |                            |                   |
      |  notismejl                 |                            |                   |
      |---------> Strato ---IMAP-->|  tools/fbmejl-hamta.ps1    |                   |
      |                            |  826 rader  <-- DEN ENDA   |                   |
      |                            |      DELEN SOM KRÄVER      |                   |
      |                            |      DIN DATOR             |                   |
      |                            |--- rpc/fbmejl_ko_in ------>| fbmejl_ko         |
      |                            |                            |   |               |
      |                            |                    pg_cron  |  v varje minut   |
      |                            |                            | fbmejl-tom (edge) |
      |                            |                            |   -> js/fbmejl.js |
      |                            |                            |   -> geokodning   |
      |                            |                            |   -> reports      |
      |                            |                            |---- fbmejl-push ->|
```

Det som ligger i repot och redan är skrivet:

| Del | Fil | Rader | Kräver din dator |
|---|---|---|---|
| Serversidan, hela | `supabase/fbmejl.sql` | 3 143 | nej |
| Tolkaren | `js/fbmejl.js` (+ `js/parser.js`) | 1 287 | nej |
| Tömning av kön | `supabase/functions/fbmejl-tom/index.ts` | 335 | nej |
| Notisen ut | `supabase/functions/fbmejl-push/index.ts` | 488 | nej |
| **Hämtningen ur postlådan** | **`tools/fbmejl-hamta.ps1`** | **826** | **JA** |
| Telegram-serversidan | `supabase/telegram.sql` | 579 | nej |
| Telegram-tolkaren | `js/telegram.js` | 562 | nej |
| Telegram-pollaren | **finns inte** | 0 | — |
| Dagens skrapare | `tools/brygg-daemon.ps1` + `tools/fb-bridge.user.js` | 9 070 | **JA** |

Kontraktet som ska uppfyllas av vad som än ersätter pollaren är en enda
funktion, och den är redan skriven, testad och rättighetssatt:

```
POST https://livvehyqowmcafnisxho.supabase.co/rest/v1/rpc/fbmejl_ko_in
Authorization: Bearer <service_role>
{ "p_mejl": [ { "message_id": "<...@facebookmail.com>",
                "from": "notification+xxxx@facebookmail.com",
                "subject": "...", "body": "...",
                "date": "2026-09-06T12:00:00Z", "uid": 4711 } ] }
```

`fbmejl_ko_in()` är idempotent på Message-ID, kör nykterhetsfiltret redan där
och skrubbar `n_m=`/`notif_id=`/`bcode=` ur texten innan något skrivs. Den som
levererar mejlet behöver alltså inte vara smart. **Det är därför bytet är
litet.**

En sak till som också hänger på datorn och som inte får glömmas bort:
`tools/supabase-keepalive.ps1`. Gratisplanen hos Supabase pausar projektet
efter ungefär en veckas tystnad, och när det pausas slutar subdomänen resolva
— hela appen dör tyst. Det hände 2026-09-01. Idag hålls projektet vaket av att
bryggan knackar var femte minut från din dator. **Stänger du av datorn dör
alltså inte bara bryggan, utan på sikt hela appen.** Den remmen måste flyttas
i samma vända, oavsett vilken väg du väljer. Se steg 7 i planen.

---

## Vägarna, en och en

### Väg 1c — REKOMMENDERAD: Facebooks notismejl, pushade in via Cloudflare

Facebook mejlar `fb@<din-domän>`. Domänens MX pekar på Cloudflare Email
Routing. En Email Worker körs på varje inkommande mejl, läser `message.raw`
(hela MIME-meddelandet, huvuden inräknat), plockar ut avsändare, ämne, datum,
Message-ID och brödtext, och POSTar till en ny edge-funktion `fbmejl-in` som
anropar `fbmejl_ko_in()`. Samma worker vidarebefordrar dessutom mejlet till
din vanliga inkorg, så du inte tappar dina egna notiser.

**Vad som krävs för att sätta igång**
- En domän vars namnservrar ligger hos Cloudflare. **Ta en ny** (t.ex.
  `polisvakt.se` — den står redan som User-Agent i `fbmejl-tom/index.ts` och i
  `docs/telegram-brygga.md`, och du behöver en riktig domän till lanseringen
  ändå). Flytta **inte** en domän som redan bär levande mejl; MX-posterna
  måste överleva flytten och det är precis den sortens sak som tystnar utan
  att synas.
- Email Routing påslaget på zonen, en adress skapad, en Email Worker deployad.
- Facebook-kontots primära e-postadress bytt till den nya adressen (väg B i
  `docs/fbmejl.md`). **Inte vidarebefordring** — vidarebefordring bryter DKIM
  och då fungerar inte äkthetskontrollen, vilket är hela poängen med att lägga
  det hos Cloudflare.
- En ny edge-funktion `fbmejl-in` (liten, ca 120 rader) och en delad hemlighet
  mellan worker och funktion.

**Kostnad:** domänen, ~130 kr/år. Email Routing är gratis. Workers gratis upp
till 100 000 anrop/dygn; gruppen ger kanske hundra i veckan.

**Ömtålighet:** låg för transporten, oförändrad för innehållet. Transporten är
SMTP och en HTTP-post — inget av det ändras av att Facebook byter klassnamn i
sin DOM. Det som fortfarande är ömtåligt är att Facebooks mejl**format** är
delvis odokumenterat (se "Vad som INTE går") och att buntade sammanfattnings-
mejl kastas med flit.

**Metas villkor:** helt inom dem. Det är dina egna notiser till din egen
adress. Ingen inloggning kringgås, ingenting skrapas.

**När du stänger av datorn:** ingenting händer. Kedjan går vidare.

---

### Väg 1a — Fallback: samma mejl, men IMAP-pollning från molnet i stället

Behåll brevlådan hos Strato. Flytta `tools/fbmejl-hamta.ps1` till en
edge-funktion som talar IMAP över TLS mot `imap.strato.de:993`, schemalagd
varje minut med pg_cron. IMAP-lösenordet i Supabase secrets.

**Vad som krävs:** en brevlåda hos Strato (`fb@…`), en regel som
vidarebefordrar allt från `facebookmail.com` dit, och att ~826 rader
PowerShell (IMAP-dialogen, `Avkoda-QuotedPrintable`, `Plocka-Brodtext`,
`Sanera-Lankar`, `Normalisera-MessageId`) skrivs om i Deno. Det är en dags
arbete, inte en eftermiddag.

**Kostnad:** noll extra — brevlådan finns i Strato-abonnemanget.

**Ömtålighet:** medel. Två saker att veta:
1. **Utgående rå TCP från edge-runtime är inte hundraprocentigt belagt.**
   Supabase-runtime stödjer TCP-baserade protokoll och `Deno.connectTls`
   (det är så deras egna Postgres- och SMTP-exempel fungerar), men port 993
   mot en extern värd är inte något jag sett dokumenterat svart på vitt.
   **Det måste bevisas med ett tjugoradigt spiktest innan man bygger något**,
   annars bränner man en dag på en vägg. Faller det, är plan B en liten
   alltid-på-process hos t.ex. Fly.io eller en VPS för 3–5 EUR/mån — helt
   ofarligt, för den loggar inte in någonstans, den läser en postlåda.
2. Lösenordet till brevlådan hamnar i molnet. `docs/fbmejl.md` valde
   uttryckligen bort det en gång ("IMAP-lösenordet ska inte finnas i molnet").
   Det valet var rimligt när alternativet var din dator. Nu är det inte det.

**Metas villkor:** helt inom dem, samma som 1c.

**När du stänger av datorn:** ingenting händer.

---

### Väg 1b — Avrådd variant: Gmail API i stället för IMAP

Vidarebefordra Facebook-mejlen till en Gmail-adress och läs den med Gmail API
över vanlig HTTPS från en edge-funktion. Lockande, för då försvinner hela
TCP-frågan i 1a.

**Varför jag avråder:** OAuth-token för en app som står kvar i "Testing" i
Google Cloud **går ut efter sju dagar**. Tyst. Kedjan skulle alltså dö varje
vecka tills appen publiceras och verifieras, och verifieringsprocessen för
Gmail-scopes är ett eget projekt. Lägg därtill att vidarebefordring bryter
DKIM. Nämner den för fullständighetens skull; den är inte värd tiden.

---

### Väg 2 — Telegram-spegling

En gruppadmin (eller ett par aktiva medlemmar) postar samma sak i en
Telegram-kanal. En bot läser kanalen med Telegrams riktiga API.

Serversidan finns: `supabase/telegram.sql` (579 rader) och `js/telegram.js`
(562 rader). **Pollaren finns inte** — den är beskriven i
`docs/telegram-brygga.md` men aldrig skriven. Det är ungefär hundra rader
edge-funktion, det är den lilla biten.

**Vad som krävs:** ett samtal med gruppens admin, och att admin sedan orkar
varje dag för alltid.

**Kostnad:** noll.

**Ömtålighet:** tekniskt den stabilaste av alla vägar — Telegrams API ändras
inte, meddelandena bär riktig tidsstämpel per inlägg (`date`/`forward_date`)
och kan till och med bära en kartnål, vilket är bättre än varje geokodat
gatunamn. **Mänskligt den bräckligaste.** Slutar admin orka finns ingenting du
kan göra åt det.

**Metas villkor:** helt inom dem, hos alla inblandade.

**När du stänger av datorn:** ingenting händer.

**Detta är den enda vägen som tar bort beroendet av din Facebook-profil och
ändå ser gruppens innehåll.** Den ska frågas om parallellt, inte i stället.
Kedjan är redan byggd för att båda vägarna ska kunna gå samtidigt utan
dubbletter: textnyckeln är identisk (`tx:<hash>:<fack>`, samma FNV-1a, samma
tretimmarsfönster) och `fbmejl_ta_emot()` slår upp i `telegram_lasta` innan
den skapar något. Samma inlägg båda vägarna blir **en** varning.

---

### Väg 3 — Meta Graph API

**Död. Inte "svår", inte "kräver granskning". Död.**

Meta annonserade avvecklingen i januari 2024 och tog bort Groups API i **alla**
API-versioner den 22 april 2024, inklusive behörigheterna
`groups_access_member_info` och `publish_to_groups`. Det finns 2026 ingen
API-väg som läser inlägg i en medlemsgrupp. Bara Pages går att läsa
programmatiskt. Zapier, Make och varje no-code-tjänst som påstår att de kan
läsa en Facebook-grupp gör det genom att logga in som en människa — det är
skrapning med annan etikett.

Det finns ingenting att utreda vidare här och ingen ansökan att skicka in.

---

### Väg 4 — Flytta skrapningen till en server/VPS

Samma `brygg-daemon.ps1`-idé, fast med headless Chrome på en hyrd maskin i
stället för på ditt skrivbord.

**Vad som krävs:** en VPS, Chrome, ditt Facebook-konto inloggat i profilen på
den maskinen, och en väg att lösa ut Metas kontrollfrågor när de kommer.

**Kostnad:** 3–8 EUR/mån.

**Ömtålighet:** **högre än i dag, inte lägre.** Tre skäl:
1. **Datacenter-IP.** Din session ser i dag ut som en människa i Västerås på
   en fast bredbandslina. Samma konto som plötsligt läser gruppen från ett
   Hetzner-block i Tyskland är precis mönstret Metas riskmodell letar efter.
2. **Kontrollfrågor och 2FA.** När Meta ber om verifiering måste *du* lösa
   den, på en maskin utan skärm, och tills du gjort det ligger bryggan nere.
   Det är mer beroende av dig, inte mindre.
3. **DOM:en ändras ändå.** Facebook byter klassnamn utan förvarning. Det syns
   inte som ett fel, det syns som att gruppen blivit tyst.

**Metas villkor:** **bryter mot dem.** Automatiserad läsning av inloggat
innehåll är precis det som förbjuds, och priset är kontot — inte en varning.
Det gäller lika mycket i dag på din dator som det skulle göra på en VPS;
skillnaden är att en VPS gör det lättare att upptäcka.

**När du stänger av datorn:** ingenting händer — men du har flyttat en
villkorsöverträdelse till en maskin som är enklare att flagga, och du behöver
fortfarande hålla en inloggning levande. Det löser fel problem.

**Rekommenderas inte.** Om du ändå vill ha den: kör den aldrig med ditt
personliga konto, och räkna med att förlora kontot. Ett "extrakonto" är
förresten också villkorsbrott, och gruppen är dessutom sluten — ett nytt konto
måste godkännas av admin, vilket är samma mänskliga beroende som Telegram fast
utan Telegrams fördelar.

---

### Väg 5 — Gruppens medlemmar rapporterar direkt i appen

Rapportknappen, rösten och chatten finns redan och är byggda. En förare kan
säga "polis vid Erikslund" utan att ta upp telefonen, vilket är snabbare än
att skriva ett Facebook-inlägg under körning.

**Vad som krävs:** användare. Inte kod.

**Kostnad:** noll i kronor, allt i tid — det här är marknadsföring och
gemenskapsbyggande, inte teknik.

**Ömtålighet:** hög i början, noll när den väl snurrar. Under kritisk massa är
kartan tom, och en tom karta ger inga nya användare. Det är kallstartsproblemet
i sin renaste form, och det är exakt vad Facebook-bryggan finns till för att
lösa: **bryggan är ställningen, inte huset.**

**Metas villkor:** irrelevant. Ingen Facebook inblandad.

**När du stänger av datorn:** ingenting händer.

**Detta är slutmålet, inte ett alternativ till väg 1.** Den dagen appen har
egna rapporter i tillräcklig takt ska Facebook-bryggan stängas av, och då
försvinner varenda risk i det här dokumentet på en gång. Planera för det: mät
andelen rapporter som kommer från appen respektive bryggan
(`reports.source`/`device_id`, se fråga 7 i `supabase/LANSERINGSKOLL.sql`), och
sätt en tröskel där bryggan får gå i graven.

---

## Jämförelsen

| | 1c Mejl→Cloudflare | 1a Mejl→IMAP i molnet | 2 Telegram | 3 Graph API | 4 VPS-skrapning | 5 Appen själv |
|---|---|---|---|---|---|---|
| Kräver din dator | **nej** | **nej** | **nej** | — | nej | **nej** |
| Kräver din FB-profil | ja | ja | **nej** | — | ja | **nej** |
| Kräver en annan människa | nej | nej | **ja** | — | nej | **ja (många)** |
| Inom Metas villkor | **ja** | **ja** | **ja** | — | **nej** | **ja** |
| Ser du alla inlägg | nej, algoritmen väljer | nej, algoritmen väljer | om admin speglar allt | — | ja | n/a |
| Fördröjning | **sekunder** | upp till en minut | sekunder | — | sekunder | sekunder |
| Riktig tid per inlägg | nej (mejlets tid) | nej (mejlets tid) | **ja** | — | ja | **ja** |
| Hemlighet i loopen | delad nyckel | **IMAP-lösenord** | bot-token | — | hel FB-session | ingen |
| Kostnad | ~130 kr/år | 0 kr | 0 kr | — | 3–8 EUR/mån | 0 kr |
| Går att bygga i dag | ja | ja | nej, kräver ja från admin | nej | ja | pågår |
| Finns redan i repot | 95 % | 95 % | 80 % | — | 100 % | 100 % |

---

## Planen för väg 1c, steg för steg

Uppdelad i **DU** och **JAG**. Jag rör aldrig domäner, konton, lösenord eller
inloggningar — de fyra är dina, och koden är byggd så att jag aldrig ser
värdena.

### Steg 0 — Mätningen som avgör allt (DU, 5 min nu + en titt i morgon)

**Gör det här innan något byggs. Det kostar noll kronor och avgör om resten av
planen håller.**

1. Facebook → Inställningar → **Aviseringar** → **E-post** → välj **Alla
   aviseringar**. Standardläget "Bara aviseringar om ditt konto" stänger av
   gruppnotismejlen helt.
2. Öppna gruppen → klockikonen → **Alla inlägg**.
3. Vänta ett dygn. Räkna sedan: **hur många mejl fick du om gruppen, jämfört
   med hur många inlägg som faktiskt postades?**

| Utfall | Vad det betyder |
|---|---|
| Mejl om de flesta inlägg | Bygg hela väg 1c. Den blir ryggraden. |
| Mejl om några få | Mejlvägen är ett komplement, inte en ryggrad. Då är Telegram (väg 2) huvudspåret och du måste prata med admin. |
| Inga mejl alls | Väg 1 är död. Kvar står Telegram och appen själv. Säg till direkt, då skriver jag om planen. |

Antalet inlägg i gruppen kan jag hjälpa dig räkna en enda kväll med den
befintliga skraparen i `-Torr`-läge (den skriver ingenting någonstans). Det är
det enda den ska användas till hädanefter.

### Steg 1 — Domänen (DU, 20 min)

1. Registrera en domän. `polisvakt.se` om den är ledig — du behöver en till
   lanseringen ändå, och den står redan inskriven som User-Agent i två filer.
2. Lägg till den i Cloudflare (samma konto som Pages ligger på) och peka
   namnservrarna dit hos registraren.
3. **Flytta inte en domän som redan bär mejl.** `pejlon.com`,
   `westrosdigitalretail.se`, `sleeppods.se` och `norillo.se` har levande MX
   hos Strato. En felaktig flytt tystar affärsmejl, och det märks först när
   någon undrar varför de inte hört av sig.

### Steg 2 — Email Routing (DU, 10 min)

Cloudflare → domänen → **Email** → Email Routing → aktivera. Cloudflare lägger
in MX- och SPF-posterna själv. Skapa adressen `fb@<domänen>` och sätt den
tills vidare att bara vidarebefordra till din vanliga inkorg, så du ser att
det fungerar innan någon kod kopplas in. Skicka ett testmejl till dig själv.

### Steg 3 — Byt primär adress på Facebook-kontot (DU, 5 min)

Facebook → Inställningar → **Kontaktuppgifter** → lägg till `fb@<domänen>`,
bekräfta den, gör den till **primär**.

Ja, det betyder att alla dina Facebook-mejl går dit. Det är avsiktligt:
workern i steg 5 vidarebefordrar allt till din vanliga inkorg i samma andetag
som den plockar ut gruppnotiserna, så du tappar ingenting. Skälet till att inte
i stället vidarebefordra från din nuvarande adress är att **vidarebefordring
bryter DKIM-signaturen**, och då kan Cloudflare inte längre skilja ett äkta
Facebook-mejl från ett förfalskat. Just den kontrollen är hela säkerheten i
upplägget: `From:` går att förfalska, och adressen leder rakt in i en funktion
som skriver till databasen.

### Steg 4 — Grupp-id och hemligheter (DU, 5 min)

Grupp-id:t är **`317968668373072`** (läst ur `brygg-bevakning.log`, raden
`kalibrerade`). Kontrollera att det stämmer mot adressfältet när du öppnar
gruppen — står det ett namn i stället för siffror i adressen är det namnet som
gäller, och stavningen måste bli exakt rätt, annars kastas varje mejl och
tystnaden ser ut precis som en tom grupp.

Sätt i Supabase → Edge Functions → Secrets:

| Hemlighet | Värde |
|---|---|
| `FB_GRUPP_ID` | `317968668373072` |
| `FBMEJL_IN_NYCKEL` | en lång slumpad sträng, samma som i workern |

**Sätt aldrig en hemlighet som heter `fbmejl_anropsnyckel` i Vault** —
`public.fbmejl_anropsnyckel()` väljer den före `service_role_key` och
resultatet blir 401 på en nyckel som ser helt rätt ut. Det står redan som
varning i `tools/fbmejl.hemligheter.json` och har bitit en gång.

### Steg 5 — Email Worker + edge-funktionen `fbmejl-in` (JAG)

Jag skriver två filer:

- **`tools/cf-email-worker/index.js`** — Email Worker. Läser `message.raw`,
  avkodar quoted-printable, plockar `Message-ID`, `From`, `Subject`, `Date`
  och brödtext, skrubbar `n_m=`/`notif_id=`/`bcode=` **innan** något lämnar
  Cloudflare, POSTar till `fbmejl-in`, och kör därefter
  `message.forward("<din vanliga adress>")` så du får ditt mejl som vanligt.
  Skickar den inget vidare-fel: en misslyckad POST får aldrig hindra
  forwarden.
- **`supabase/functions/fbmejl-in/index.ts`** — tar emot, kontrollerar
  `FBMEJL_IN_NYCKEL`, anropar `fbmejl_ko_in()` med service_role. Ungefär 120
  rader. Ingen tolkning — den ligger kvar i `js/fbmejl.js` där den hör hemma,
  av exakt samma skäl som PowerShell-pollaren inte tolkar något: en andra
  ordlista blir förr eller senare en andra sanning om nykterhetsfiltret.

Skrubbningen finns då i fyra led (worker, `js/fbmejl.js`, `fbmejl_sanera()`,
och `fbmejl_ko_in()`). Det är med flit — en avvikelse där kan bara betyda att
ett led skrubbar mer än ett annat, och det är ofarligt.

Jag portar också testerna: `fbmejl-test.html` får en ny svit som matar
workern med riktiga `.eml`-filer.

### Steg 6 — Deploy (DU kör kommandona, JAG skriver dem)

`supabase/DEPLOY-EDGE.md` är redan skriven och gäller ordagrant. Fyra
funktioner väntar dessutom redan på att deployas med säkerhetsfixar från
2026-09-05 (git `76dde9d`, `3316bfa`) — de har aldrig rullats ut. Lägg
`fbmejl-in` till samma vända:

```bash
npx --yes supabase login                     # engångs, DU, jag rör aldrig token
npx --yes supabase functions deploy fbmejl-in  --project-ref livvehyqowmcafnisxho --no-verify-jwt
npx --yes supabase functions deploy fbmejl-tom --project-ref livvehyqowmcafnisxho --no-verify-jwt
npx --yes supabase functions deploy fbmejl-push --project-ref livvehyqowmcafnisxho
```

Cloudflare-workern deployas med `npx wrangler deploy` från
`tools/cf-email-worker/`, och kopplas till adressen i Email Routing-vyn.

Sätt sedan adresserna som `fbmejl.sql` behöver för att schemalägga tömningen:

```sql
select public.fbmejl_satt_installning('fbmejl_tom_url',
  'https://livvehyqowmcafnisxho.supabase.co/functions/v1/fbmejl-tom');
select public.fbmejl_satt_installning('fbmejl_push_url',
  'https://livvehyqowmcafnisxho.supabase.co/functions/v1/fbmejl-push');
```

och kör om `supabase/fbmejl.sql` **plus migrationerna efteråt, i den
ordningen** — filens eget varningshuvud säger varför: en omkörning utan
migrationerna skriver tyst tillbaka notisrutten till "alla får allt".

### Steg 7 — Klipp navelsträngen till datorn (JAG + DU)

Det här steget är lika viktigt som resten och glöms alltid bort.

1. **Keepaliven.** `tools/supabase-keepalive.ps1` körs i dag på din dator. Så
   fort skraparen stängs av är det den enda saken som hindrar Supabase från
   att pausa projektet. Ersätts av ett gratis externt cron-anrop var sjätte
   timme mot ett publikt REST-anrop, eller av en Cloudflare Worker med Cron
   Trigger på samma konto som Pages. **JAG** skriver den, **DU** klistrar in
   den publika nyckeln.
2. **Skraparen.** Avregistrera de schemalagda uppgifterna:
   ```powershell
   Unregister-ScheduledTask -TaskName 'Polisvakt-brygga' -Confirm:$false
   ```
   Gör det **först när mejlvägen levererat i ett dygn**, inte innan. Ha båda
   igång under överlappet — avdubblingen på textnyckel gör det ofarligt, samma
   inlägg båda vägarna blir en varning.
3. **Uppföljningen.** `select * from public.fbmejl_halsa;` en gång om dagen
   första veckan. Titta särskilt på `liggande_i_ko` (växer = ingen tömmer kön)
   och `mejl_dygn` (noll = Facebook mejlar inte).

### Steg 8 — Fråga admin om Telegram (DU, ett meddelande)

Parallellt, inte i stället. Argumentet som brukar landa: Facebook visar inte
inläggen i tid, algoritmen sorterar, och en varning som dyker upp fyrtio
minuter senare är värdelös. Erbjud dig att sätta upp kanalen och sköta den —
för admin blir det mer räckvidd, inte mer arbete.

Säger admin ja skriver **JAG** Telegram-pollaren (ca 100 rader, den enda
saknade biten) och då har du två ben, varav det ena inte behöver din
Facebook-profil alls.

---

## Vad som INTE går

Rakt, utan omskrivningar.

1. **Det går inte att läsa gruppen via ett API.** Meta tog bort Groups API
   den 22 april 2024, i alla versioner. Det finns ingen ansökan, ingen
   partnerstatus och ingen betald nivå som ger tillbaka det. Varje tjänst som
   påstår motsatsen loggar in som en människa.

2. **Det går inte att komma ifrån ditt Facebook-konto och ändå läsa gruppen
   från Facebook.** Gruppen är sluten. Någon måste vara medlem. Antingen är
   det du (väg 1), eller någon annan som frivilligt speglar (väg 2), eller så
   slutar ni läsa Facebook (väg 5). Ett extrakonto är villkorsbrott och måste
   dessutom godkännas av admin.

3. **Det går inte att garantera att du ser alla inlägg via mejl.** Det finns
   inget e-postval på gruppnivå — e-post styrs bara på kontonivå, allt eller
   inget — och Facebook aviserar bara om det algoritmen väljer. Täckningen är
   varken din eller min att styra, och den kan ändras utan förvarning. Det är
   den enskilt största svagheten i rekommendationen och det är därför steg 0
   finns.

4. **Det går inte att få rätt tid per inlägg via mejl.** Tidsstämpeln är när
   mejlet skickades, inte när inlägget skrevs. Buntade sammanfattningsmejl
   saknar tid per inlägg helt och **kastas med flit** — en varning med fel tid
   är den sortens fel som får en förare att sluta lita på appen. Börjar
   Facebook bunta mer slutar mejlvägen leverera, tyst, men synligt i
   `fbmejl_halsa.bortsorterade`.

5. **Facebooks mejlformat är delvis obelagt.** Avsändardomänen, den
   VERP-slumpade lokaldelen, notislänken och omslaget (`/n/?`, `/nd/?`) är
   belagda mot riktiga meddelanden. **Ämnesradens form är det inte** — inte en
   enda verbatim ämnesrad gick att hitta. Därför nycklar avdubblingen på
   länken och gruppfiltret på grupp-id, aldrig på ämnet. Första riktiga mejlet
   måste sparas och läsas: `.\tools\fbmejl-hamta.ps1 -Fran 0 -Spara .\fbmejl-prov -Torrkor`
   (lägg `fbmejl-prov/` i `.gitignore` först — filerna innehåller andra
   människors namn och din egen adress oskrubbad).

6. **Jag kan inte göra stegen som kräver dig.** Domänregistrering, DNS,
   Facebook-inloggning, byte av primär adress, Supabase-inloggning och
   nycklar. Det är inte en artighet — koden är medvetet byggd så att jag
   aldrig ser värdena.

7. **Ingen av vägarna larmar av sig själv när den tystnar.** `fbmejl_halsa`
   svarar på frågan, men bara om någon ställer den. En kö som ingen tömmer ger
   noll varningar och ser i övrigt fullständigt frisk ut: pollaren rapporterar
   framgång, `senast_kord` uppdateras, inget larm går. Det är den tystaste
   feltypen i hela systemet och den har redan inträffat en gång (bryggan låg
   nere 24–29 augusti utan att någon märkte det). En riktig larmning är inte
   byggd och bör byggas.

8. **Supabase gratisplan är fortfarande en tickande sak.** Projektet pausas
   efter en veckas tystnad och när det pausas slutar subdomänen resolva —
   appen dör, inte bara bryggan. Keepaliven i steg 7 hanterar det, men det
   riktiga svaret den dagen du tar betalt av kunder är Pro-planen. Att en
   betaltjänst för 99 kr/mån hänger på en gratisdatabas som kan pausa sig
   själv är en affärsrisk, inte en teknisk.

---

## Sammanfattat i tre meningar

Mejlvägen är redan byggd och bara ett enda led av den sitter fast i din dator;
byt det ledet mot ett mejl som knackar på självt via Cloudflare, så är hela
kedjan molnbaserad, gratis, inom Metas villkor och oberoende av om du är hemma.
Men mät först hur många av gruppens inlägg Facebook faktiskt mejlar om, för är
svaret "några få" är mejlvägen ett komplement och inte en ryggrad. Och fråga
admin om Telegram samma dag, för det är den enda vägen som ser gruppens
innehåll utan att hänga på din profil — medan det riktiga slutmålet är att
appens egna användare rapporterar och att bryggan får läggas ner.
