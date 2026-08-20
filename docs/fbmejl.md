# Mejlbryggan

Facebooks egna notismejl som väg in från gruppen "Här står polisen".

Det här är det tredje spåret. De två andra är userscriptet
(`tools/fb-bridge.user.js`) och Telegram-spegeln (`docs/telegram-brygga.md`).
Sist i den här filen står en rak jämförelse mellan alla tre.

---

## LÄS DET HÄR INNAN DU SÄTTER UPP NÅGOT

**Det finns inget e-postval på gruppnivå på Facebook.**

Facebooks egen hjälpsida listar gruppens aviseringsval under rubrikerna
*In-app notifications* och *Push notifications*. E-post finns inte där. E-post
styrs **bara på kontonivå** — allt eller inget, för alla grupper du är med i.

Och värre: en leverantörskälla, i linje med många användarrapporter, säger att
Facebook bara aviserar om inlägg som **algoritmen väljer** — även med "Alla
inlägg" påslaget.

**Ett mejl per inlägg är alltså inte garanterat.** Det är inget koden kan lösa;
den kan bara tolka de mejl som faktiskt kommer.

### Vad du ska göra åt det

Innan du bygger något: **slå på kontots e-postaviseringar, vänta ett dygn, och
räkna.** Jämför antalet mejl du fått om gruppen med antalet inlägg som faktiskt
postades i den.

- Får du mejl om **de flesta** inlägg — bygg hela kedjan.
- Får du mejl om **några få** — mejlbryggan är ett komplement, inte en
  ryggrad. Satsa på Telegram.
- Får du **inga** — spåret är dött. Sluta här, du sparar en eftermiddag.

Det här mätvärdet är det enda som avgör om resten av dokumentet är värt att
läsa.

---

## Det ärliga sedan, två saker

### 1. Formatet är DELVIS belagt

Facebook publicerar ingen specifikation. En del av formatet gick ändå att
belägga mot riktiga råmeddelanden; resten är antaganden.

#### BELAGT

| Fakta | Var det sitter |
|---|---|
| Avsändardomänen är `facebookmail.com`, underdomäner förekommer (`priority.facebookmail.com`) | `FB_DOMANER` |
| **Lokaldelen är VERP-slumpad per mottagare**: `notification+meynbxsa@`, `update+fswuaytwzzmw@`, `notification+kjdm---m7wwd@` | `arFacebookAvsandare` |
| `From` == `Return-Path` == `Errors-To`. `noreply@facebookmail.com` är **Reply-To**, alltså inte avsändaren | poller + parser |
| Gruppnotislänken: `facebook.com/groups/<gid_eller_slug>/<post_id>/?notif_t=group_activity&notif_id=…` | `plockaInlaggsId` |
| Länken ligger i ett omslag: `facebook.com/n/?<procentkodad sökväg>&medium=email&mid=<per-mejl-id>&bcode=…&n_m=…`. Nyare mejl använder `/nd/?` | `packaUppOmslag` |
| `Message-ID` finns (hex-lokaldel på en facebook.com-värd) | `normaliseraMessageId` |
| `n_m=` bär mottagarens mejladress i klartext; `notif_id=` ger läsåtkomst till innehållet | `HEMLIGA_PARAMS` |

> **Matcha domänen, aldrig lokaldelen.** En kontroll på
> `notification@facebookmail.com` hade kastat varenda riktigt mejl, och felet
> hade sett ut som "Facebook skickar inga mejl". Samma sak för IMAP-sökningen i
> pollaren.

> Påståenden på nätet om att `groupupdates@` eller liknande skulle vara
> reserverat för grupper är obelagd SEO-text. Bygg ingenting på dem.

#### ANTAGET — måste verifieras mot ett riktigt mejl

| Antagande | Var det sitter | Vad som händer om det är fel |
|---|---|---|
| Ämnesradens form ("X skrev i Y") | `INLAGGSRADER` | Rubrikraden städas inte bort. Tilliten sjunker. **Ingen dedup nycklar på ämnet** — se nedan. |
| Brödtexten innehåller inläggets text | `plockaInlagg` | Allt kastas som `tom`. Kön fylls, inga varningar. |
| Foten går att känna igen | `SKRAPRADER` | Skräp följer med in i `note` och sänker tilliten. |
| Buntade mejl går att känna igen | `SAMMANFATTNINGS_FRASER` | En bunt blir en varning med fel tid, eller kastas som `obegriplig`. |

**Ämnesraden går inte att lita på.** Inte en enda verbatim ämnesrad för ett
gruppinlägg gick att hitta, varken på svenska eller engelska. Det som går att
belägga är att in-app-notisens mening kopieras rakt av och **trunkeras med tre
punkter**. Därför:

- avdubblingen nycklar på **länken**, inte på ämnet
- gruppfiltret bör använda `gruppId` (grupp-id ur länken), inte gruppens namn
- `plockaUrAmne()` kapar bort trunkeringspunkterna, annars blir
  "Erikslund..." en egen plats att geokoda

**Två saker jag tagit bort för att de inte gick att belägga:**
`List-Unsubscribe` fanns inte i något äkta prov, och `X-Facebook-Notify`
(`mailid=`) finns i äldre korpusar men om det lever kvar 2026 är obelagt.
Koden använder ingetdera.

Alla mönster är **exporterade listor**, inte inbakade regexar. Stämmer något
inte lägger man till en rad, man skriver inte om en funktion.

Det som INTE är antaget: produktreglerna. De körs på texten efter tolkningen,
och misslyckas tolkningen helt blir resultatet noll varningar — aldrig fel
varningar. `fbmejl-test.html` bevisar att koden gör rätt sak *med det antagna
formatet*; den bevisar inte att antagandet stämmer.

### 2. Buntningen kan sänka hela idén

Facebook buntar ihop notiser till sammanfattningar. Exakt när och hur ofta har
jag inte kunnat belägga — det verkar bero på hur många notiser man får, hur
ofta man loggar in, och vilka inställningar som är satta.

Det spelar roll, för latenskravet är **en minut**. Ett buntat mejl har ingen
tidsstämpel per inlägg, bara en för hela bunten, och därför **kastas det**
(`SKAL.SAMMANFATTNING`). Ett inlägg som är fyrtio minuter gammalt får inte
läggas ut som färskt; en varning med fel tid är den sortens fel som får en
förare att sluta lita på appen.

**Det betyder att om Facebook börjar bunta ihop mejlen slutar mejlbryggan att
leverera — tyst, men synligt i `fbmejl_halsa`.** Det är den enskilt största
risken med det här spåret. Håll koll på `sparrade_dygn` och
`bortsorterade`-räknaren första veckan.

Motmedlet är inställningarna. Facebook buntar mindre när man bett om notis för
*varje* inlägg i en enskild grupp, och mer när man har hundratals olästa
notiser. Se nästa avsnitt.

---

## Så här funkar det

```
Facebook            Strato               Windows                Supabase                Telefonen
  |                   |                    |                       |                        |
  |  notismejl        |                    |                       |                        |
  |------------------>|                    |                       |                        |
  |                   |  IMAP, var 30:e s  |                       |                        |
  |                   |<-------------------|  fbmejl-hamta.ps1     |                        |
  |                   |                    |   RÅ TEXT ----------->|  fbmejl_ko             |
  |                   |                    |                       |    |                   |
  |                   |                    |                       |    v                   |
  |                   |                    |   edge: fbmejl-tom -->|  js/fbmejl.js          |
  |                   |                    |                       |    -> js/parser.js     |
  |                   |                    |                       |    -> geokodning       |
  |                   |                    |                       |    v                   |
  |                   |                    |                       |  fbmejl_ta_emot()      |
  |                   |                    |                       |    -> reports          |
  |                   |                    |                       |    -> fbmejl_notis_ut()|
  |                   |                    |                       |----- push ------------>|
```

Tre delar, och de kan gå sönder oberoende av varandra:

1. **`tools/fbmejl-hamta.ps1`** läser postlådan över IMAP och lägger RÅTEXTEN i
   `public.fbmejl_ko`. Den tolkar ingenting.
2. **Edge-funktionen `fbmejl-tom`** hämtar ur kön, kör `js/fbmejl.js` (som
   anropar `js/parser.js`), geokodar och anropar `public.fbmejl_ta_emot()`.
3. **`fbmejl_ta_emot()`** skapar rapporterna och skickar EN push per omgång via
   `fbmejl_notis_ut()`.

### Varför två steg och inte ett

Tolkningen måste ligga i `js/fbmejl.js`, för det är den enda vägen till
`js/parser.js` — och `js/parser.js` äger nykterhetsfiltret. Pollaren är
PowerShell och kan inte köra JavaScript; det finns ingen Node på maskinen. Att
låta PowerShell leta efter ordet "polis" hade gett en andra ordlista, och en av
dem hade varit produktregel nummer ett.

Kön är dessutom en försäkring: går tolkaren ner ligger mejlen kvar och kan
köras om. Rapporterna går inte förlorade bara för att en edge-funktion hostar.

**Baksidan, sagd rakt ut:** en kö som ingen tömmer ger noll varningar och ser i
övrigt helt frisk ut. Pollaren rapporterar framgång, `senast_kord` uppdateras,
inget larm går. Kolla `fbmejl_halsa.liggande_i_ko` — det är det talet som
avslöjar det.

---

## Vad du måste göra

### Steg 1 — En egen postlåda

Skapa en adress hos Strato som **inte används till något annat och inte står
någonstans publikt**, t.ex. `fb@dindoman.se`.

Varför en egen: skriptet läser allt som kommer från `facebookmail.com` i den
brevlådan. Ligger den i din vanliga inkorg läser skriptet din post, och
service_role-nyckeln finns på samma maskin.

**Sätt spamfiltret att KASTA det som inte klarar DKIM/SPF, inte flytta det till
skräpkorgen.** Det här är den riktiga säkerheten. `From:` går att förfalska —
vem som helst som listar ut adressen kan skicka ett mejl som påstår sig komma
från `notification@facebookmail.com`, och `arFacebookAvsandare()` i
`js/fbmejl.js` skulle säga ja. Kontrollen i koden är ett grovt första nät, inte
skyddet. Skyddet är att mejlet aldrig hamnar i brevlådan.

### Steg 2 — Få Facebook att mejla dit

Facebook skickar notismejl till kontots **primära** adress. Två vägar:

**A. Vidarebefordring (rekommenderas).** Låt kontot behålla din vanliga adress
och sätt en regel hos den leverantören: allt från `facebookmail.com`
vidarebefordras till `fb@dindoman.se`. Du behåller dina vanliga notiser och
bryggan får en kopia.

*Observera:* vidarebefordring bryter DKIM-signaturen om leverantören skriver om
huvudena. Klarar din leverantör inte SRS/ARC får du välja väg B, annars
fungerar inte äkthetskontrollen i steg 1.

**B. Byt primär adress på Facebook-kontot** till `fb@dindoman.se`. Enklast
tekniskt, men då hamnar alla dina Facebook-mejl där.

### Steg 3 — Slå på notiserna på Facebook

Läs varningen högst upp i filen först. Kort version: **det finns inget
e-postval på gruppnivå.** Två inställningar, och de gör olika saker:

1. **I kontot — den som faktiskt styr e-posten:** Inställningar →
   **Aviseringar** → **E-post** → välj **Alla aviseringar** (*All
   notifications*). Standardläget "Bara aviseringar om ditt konto" stänger av
   gruppnotismejlen helt. **Utan den här får du inga mejl över huvud taget.**

2. **I gruppen — styr bara vad Facebook aviserar om, inte hur:** öppna "Här
   står polisen" → klockikonen / **Aviseringar** → **Alla inlägg** (*All
   posts*). Valet står under *In-app notifications* och *Push notifications*;
   det finns ingen e-postrad där. Slå ändå på det — det är det närmaste du
   kommer att säga åt Facebook att bry sig om varje inlägg.

> Facebook flyttar runt de här menyerna regelbundet. Hittar du inte texterna:
> leta efter ett e-postval i kontots aviseringsinställningar och efter "Alla
> inlägg" i gruppens aviseringsmeny. Namnen ändras, valen finns kvar.

**Även med båda påslagna aviserar Facebook bara om inlägg algoritmen väljer.**
Räkna täckningen ett dygn innan du bygger resten — se varningen högst upp.

### Steg 4 — Hemligheterna

Tre saker, och ingen av dem får hamna i git. Repot är publikt.

Miljövariabler är bäst för ett schemalagt jobb — de finns bara i processen och
följer inte med om projektmappen synkas till OneDrive, vilket den här mappen
faktiskt gör. Kör en gång i PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('PV_IMAP_ANVANDARE', 'fb@dindoman.se', 'User')
[Environment]::SetEnvironmentVariable('PV_IMAP_LOSEN', 'xxxxx', 'User')
[Environment]::SetEnvironmentVariable('PV_IMAP_SERVER', 'imap.strato.de', 'User')
[Environment]::SetEnvironmentVariable('PV_SUPABASE_URL', 'https://livvehyqowmcafnisxho.supabase.co', 'User')
[Environment]::SetEnvironmentVariable('PV_SUPABASE_SERVICE_KEY', 'eyJ...', 'User')
[Environment]::SetEnvironmentVariable('PV_FB_GRUPP', 'Här Står Polisen - Västerås', 'User')
# Grupp-id:t ur adressfältet när du öppnar gruppen. OBLIGATORISKT.
[Environment]::SetEnvironmentVariable('PV_FB_GRUPP_ID', '317968668373072', 'User')
```

**`gruppId` är obligatorisk.** Saknas både `gruppId` och `grupp` vägrar
`js/fbmejl.js` att tolka och svarar med skälet `inget-gruppfilter`. Att köra
utan filter kräver ett uttryckligt `kravGrupp: false`. Förvalet var förut att
släppa igenom allt, vilket betydde att varje grupp kontot är med i kunde
hamna på kartan — fel förval ska stoppa, inte varna.

**Stava den som i länken.** Facebook använder antingen siffror
(`/groups/1234567890/`) eller ett eget namn (`/groups/harstarpolisen/`), och
jämförelsen är exakt. Sätter du siffrorna medan länken bär namnet läser
bryggan ingenting alls — och tystnaden ser precis ut som ett tomt flöde. Det
går inte att lösa i kod: ingenting i mejlet säger att de två är samma grupp.
Därför syns det i stället i summeringen som `fel grupp: harstarpolisen`. Ser
du den raden är det stavningen som är fel, inte flödet som är tomt.

Vill du hellre ha en fil heter den `tools/fbmejl.hemligheter.json`:

```json
{
  "Server": "imap.strato.de",
  "Anvandare": "fb@dindoman.se",
  "Losen": "xxxxx",
  "SupaUrl": "https://livvehyqowmcafnisxho.supabase.co",
  "SupaKey": "eyJ...",
  "Grupp": "Här står polisen"
}
```

**Lägg till raden i `.gitignore` INNAN du skapar filen.** Skriptet kör
`git check-ignore` och **vägrar starta** om filen inte är ignorerad — men det
skyddar inte mot att du skapar den och committar i samma andetag.

### Steg 5 — Databasen

Kör i Supabase SQL Editor, i den här ordningen:

1. `supabase/schema.sql` (om den inte redan är körd)
2. `supabase/kvalitetsfalt.sql`
3. `supabase/push.sql` (behövs för notiserna)
4. `supabase/fbmejl.sql`

Sedan, i en **ny** flik (databasinställningar slår igenom först i nya
anslutningar):

```sql
alter database postgres set app.service_role_key  = 'eyJ...';
alter database postgres set app.fbmejl_tom_url    = 'https://<projekt>.supabase.co/functions/v1/fbmejl-tom';
alter database postgres set app.fbmejl_push_url   = 'https://<projekt>.supabase.co/functions/v1/fbmejl-push';
```

Kör `supabase/fbmejl.sql` igen efteråt så schemaläggningen hittar adresserna.
Kontrollfrågorna längst ner i filen går igenom allt som kan vara fel.

### Steg 6 — Torrkörning

**Gör det här innan du schemalägger något.**

```powershell
.\tools\fbmejl-hamta.ps1 -Torrkor
```

Skriptet ansluter, läser de senaste mejlen och visar avsändare, ämne och de
första raderna av brödtexten. Databasen rörs inte, UID:t flyttas inte fram.

Ser det rätt ut, kör en riktig omgång:

```powershell
.\tools\fbmejl-hamta.ps1
```

och titta i kön:

```sql
select message_id, amne, status, skal, left(brodtext, 200) from public.fbmejl_ko
 order by hamtat_at desc limit 10;
```

### Steg 7 — Schemalägg pollaren

Pollaren kör på din Windows-maskin, inte i molnet. Det är med flit:
IMAP-lösenordet ska inte ligga hos Supabase.

```powershell
$a = New-ScheduledTaskAction -Execute 'powershell.exe' `
     -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\ellio\OneDrive\Claude code 2GNDTN\polisvakt\tools\fbmejl-hamta.ps1"'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) `
     -RepetitionInterval (New-TimeSpan -Minutes 1)
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
     -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'Polisvakt-fbmejl' -Action $a -Trigger $t -Settings $s
```

`-MultipleInstances IgnoreNew` är viktig: en långsam körning ska inte staplas
ovanpå nästa.

**Datorn måste vara igång.** Se `docs/`-anteckningen om strömschema — sover
maskinen slutar bryggan leverera utan att något syns i appen. Vill du ha en
process som ligger kvar istället för ett schemalagt anrop:
`.\tools\fbmejl-hamta.ps1 -Loop -Intervall 30`.

---

## Edge-funktionerna

Två stycken, och de **finns nu i repot** (skapade 20 aug 2026):
`supabase/functions/fbmejl-tom/index.ts` och
`supabase/functions/fbmejl-push/index.ts`.

Koden nedan är den ursprungliga skissen och är **inte** vad som ligger i
repot. De färdiga filerna kör ett mejl i taget, så att ett nätverksfel i
geokodningen inte markerar mejlet som bortsorterat, och de kräver
`Authorization: Bearer <service_role_key>` — anon-nyckeln ligger i appens
källkod och hade annars räknats som en giltig JWT. Läs filerna, inte skissen.

### `supabase/functions/fbmejl-tom/index.ts`

Tömmer kön, tolkar och skapar rapporter.

```ts
// Hämtar råa mejl ur public.fbmejl_ko, tolkar dem med js/fbmejl.js och lämnar
// färdiga rader till public.fbmejl_ta_emot(). All tolkning sker i
// js/fbmejl.js -> js/parser.js. Ingen ordlista finns här.

import { bearbeta, SKAL, summeringText }
  from 'https://polisvakt.pages.dev/js/fbmejl.js';

const SUPA    = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Grupp-id ur länken (/groups/<gid>/...). Det här är rätt filter — gruppens
// NAMN står bara i ämnesraden, och ämnesraden trunkeras.
const GRUPP_ID = Deno.env.get('FB_GRUPP_ID') ?? '';
const GRUPP    = Deno.env.get('FB_GRUPP') ?? 'Här står polisen';   // fallback

const APP = 'https://polisvakt.pages.dev';
const VIEWBOX = [15.10, 59.30, 17.30, 60.30];      // Västmanland

const rpc = async (fn: string, args: unknown = {}) => {
  const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return await r.json().catch(() => null);
};

// Samma geokodning som telegram-poll använder — kopiera funktionen geokoda()
// ur docs/telegram-brygga.md rakt av, den är identisk.
async function geokoda(plats: string) { /* se docs/telegram-brygga.md */ }

Deno.serve(async () => {
  try {
    const ko = await rpc('fbmejl_ko_hamta', { p_antal: 25 }) ?? [];
    if (!ko.length) return new Response('inget i kön');

    const mejl = ko.map((r: any) => ({
      messageId: r.message_id,
      from:      r.avsandare,
      subject:   r.amne,
      body:      r.brodtext,
      date:      r.skickat_at,
    }));

    const s = await bearbeta(mejl, {
      geokoda,
      ...(GRUPP_ID ? { gruppId: GRUPP_ID } : { grupp: GRUPP }),
    });

    if (s.rapporter.length) {
      // Notisen skickas av fbmejl_ta_emot(), inte härifrån. En omgång = en
      // notis; skulle den här funktionen ringa själv blev det en per rapport.
      await rpc('fbmejl_ta_emot', { p_rader: s.rapporter });
    }

    // Allt som INTE blev en rapport måste markeras, annars plockas det upp
    // igen tills forsok slår i taket.
    const klara = new Set(s.rapporter.map((r: any) => r.message_id));
    const kvar = mejl.map(m => m.messageId).filter(id => !klara.has(id));
    if (kvar.length) await rpc('fbmejl_ko_avfard', { p_message_ids: kvar, p_skal: 'bortsorterad' });

    console.log(summeringText(s));
    return new Response(summeringText(s));
  } catch (e) {
    console.error(e);
    return new Response(String(e), { status: 500 });
  }
});
```

### `supabase/functions/fbmejl-push/index.ts`

Skickar pushen. Anropas av `fbmejl_notis_ut()` via pg_net med
`{ titel, text, tag, url, antal }`.

Bygg den som en kopia av `supabase/functions/send-reminder/index.ts` med tre
ändringar:

1. Mottagarna hämtas med `fbmejl_push_mottagare` istället för
   `due_push_reminders`.
2. Nyttolasten byggs **inte** i funktionen — den kommer i anropets kropp.
   Skicka `{ title: titel, body: text, tag, url }` vidare till webpush, precis
   de fält `sw.js` läser.
3. Vid 404/410 anropas `drop_push_subscription` som vanligt.

> `sw.js` förväntar sig `{ title, body, tag, url }`. Databasen skickar
> `{ titel, text, tag, url }`. Översättningen sker i edge-funktionen. Missar du
> den visas "Polisvakt / Dags att köra?" på varje gruppnotis — standardvärdena
> i push-lyssnaren.

---

## Notiserna

### Takten

Det här är den enda designfrågan i hela bygget som inte har ett tekniskt svar.

Gruppen är livlig. En fredagseftermiddag kan ge tiotals inlägg i timmen. En
notis per inlägg betyder en telefon som ringer var tredje minut, och
konsekvensen av det är känd: **användaren stänger av notiser för Polisvakt.**
Inte för gruppnotiserna — för appen. Då tystnar körpåminnelsen med, och den är
det enda som får folk att öppna appen *innan* de kör.

Fyra spärrar, alla i `public.fbmejl_notis_ut()`:

| Spärr | Värde | Varför just det |
|---|---|---|
| Buntspärren | 1 notis per omgång | Fyra varningar samtidigt är ett besked, inte fyra. |
| Glesspärren | minst 10 min emellan | Varningarnas livslängd är 30–60 min. Den som fick en notis för tio minuter sedan och öppnade appen ser den nya på kartan redan. |
| Nattspärren | 06:00–23:00 svensk tid | En varning som väcker någon 03:00 kostar mer förtroende än den kan ge. |
| Dygnstaket | 12 per dygn | Är gruppen så aktiv att taket slår i är appen inte längre kanalen — då öppnar man den. |

Alla fyra är **parametrar**, inte konstanter. Vill du ha nattnotiser:

```sql
select public.fbmejl_notis_ut('[]'::jsonb, 10, 12, 0::smallint, 24::smallint);
```

Ingenting går tyst förlorat. Varje undertryckt omgång räknas upp i
`fbmejl_notis_lage.odelade`, och nästa notis som får gå säger hur många
varningar som kommit sedan sist ("**7 nya varningar i gruppen**").

### Vad notisen säger

Typ plus plats. Ingenting mer. **Aldrig inläggets råa text.**

- En varning: "**Polis vid Erikslund**" / "Ny rapport från gruppen. Öppna
  Polisvakt för att se var på kartan."
- Flera: "**3 nya varningar i gruppen**" / "Erikslund · E18 · Björnövägen"

Skälet är inte estetiskt. `note` är en främlings ord ordagrant, hämtade ur ett
mejl vi inte kontrollerar, och en notis är det enda i appen som dyker upp på en
låst skärm utan att någon bett om det. Det som får visas där måste vara byggt
av fält vi själva har validerat: typen är en av fyra kända strängar, platsen är
geokodningens etikett. Skickar man vidare råtexten har man byggt en kanal där
vem som helst i en Facebook-grupp kan skriva vad som helst rakt in på en
främlings låsskärm.

### Nykterhetskontroller ger inte ens en notis

En notis som säger "något har hänt i gruppen" efter en nykterhetskontroll
**vore** nykterhetsvarningen. Föraren behöver inte veta var kontrollen står för
att sakta ner och ta en annan väg — det räcker att veta att det står något.

Därför byggs notisen uteslutande av rader som faktiskt blev rapporter
(`v_nya` i `fbmejl_ta_emot`), och en nykterhetskontroll blir aldrig en rad.
Regeln körs tre gånger på vägen: i `fbmejl_ko_in()` när mejlet läggs i kön, två
gånger i `js/fbmejl.js` (rå text och rensad text, båda före parsern), och en
fjärde gång i `fbmejl_ta_emot()`. Se kontroll 9 i `supabase/fbmejl.sql`.

### Slå på dem

Notiserna är **av som standard**. Kolumnen
`push_subscriptions.gruppnotiser` är `false` tills någon slår på den.

Innan appen har en knapp, slå på för din egen telefon:

```sql
update public.push_subscriptions set gruppnotiser = true
 where device_id = '<ditt-device-id>';        -- står i appens inställningar

select public.fbmejl_gruppnotis_antal();      -- ska ge minst 1
```

---

## Integritet — två saker i länkarna som aldrig får lagras

Facebooks notislänkar bär två saker som inte är harmlösa:

| Parameter | Vad det är |
|---|---|
| `n_m=` | **Mottagarens e-postadress i klartext**, procentkodad (`n_m=elliot%40exempel.se`) |
| `notif_id=` | Ger **läsåtkomst till notisens innehåll**. Ingen inloggning behövs. |
| `bcode=` | Samma sorts kvitto |

Utan skrubbning hade mottagarens mejladress hamnat i `fbmejl_ko.brodtext`, i
`note` på varje rapport, och därmed i varje backup av databasen.

De skrubbas i **tre led**, med flit:

1. `tools/fbmejl-hamta.ps1` → `Sanera-Lankar`, **innan texten lämnar din
   maskin**. Det ledet är det som räknas mest.
2. `js/fbmejl.js` → `saneraLankar()`, innan något tolkas.
3. `supabase/fbmejl.sql` → `fbmejl_sanera()`, innan något skrivs.

### `&amp;`-fällan — den som faktiskt läckte

Alla tre leden krävde förut att tecknet **omedelbart** före parameternamnet
var `?`, `&`, `%3F` eller `%26`. Men i giltig HTML skrivs en `href` med
`&amp;`, och Facebooks notismejl **är** HTML-brev. Tecknet före `n_m` är då
ett semikolon, ingen regex matchade, och adressen låg kvar i klartext i alla
tre leden samtidigt.

Ett mönster som bara täcker den ena skrivformen är alltså inget skydd alls.
Separatorn måste tåla:

| Form | Var den dyker upp |
|---|---|
| `&n_m=` | ren text |
| `&amp;n_m=` | **HTML-brevets normalform** |
| `&amp;amp;n_m=` | dubbelkodat, händer när brev vidarebefordras |
| `&#38;` / `&#x26;` | numeriska entiteter |
| `%26` / `%2526` | procentkodat och dubbelt procentkodat |

Värdeklassen måste dessutom släppa igenom quoted-printables mjuka radbrott
(`=` följt av CRLF), annars kapas matchningen mitt i adressen och resten blir
kvar. PowerShell-ledet måste avkoda quoted-printable **före** skrubbningen —
gör det inte det ligger `&am=\np;n_m=…` kvar oskrubbat.

`mid=` lämnas orörd med flit: den är dedupnyckel och avslöjar ingenting.

Tre exemplar är avsiktligt. Till skillnad från nykterhetsfiltret kan en
avvikelse här bara betyda att ett led skrubbar *mer* än ett annat, och det är
ofarligt.

Sökvägen lämnas intakt så grupp-id och inläggs-id går att läsa ut, och `mid=`
lämnas kvar — den är en dedupnyckel och avslöjar ingenting om mottagaren.

> **Undantaget:** `.eml`-filerna som `-Spara` skriver sparas **oskrubbade**,
> med flit — de finns för att du ska kunna se exakt vad Facebook skickar. De
> innehåller alltså din mejladress och ett `notif_id`. Lägg `fbmejl-prov/` i
> `.gitignore` och radera mappen efteråt.

---

## Verifiera mot ett riktigt mejl

Det här är det viktigaste jobbet i hela filen och det tar tio minuter.

```powershell
.\tools\fbmejl-hamta.ps1 -Fran 0 -Spara .\fbmejl-prov -Torrkor
```

Nu ligger varje mejl som en `.eml`-fil i `fbmejl-prov\`. Öppna en av dem i
Anteckningar. De tre första frågorna är redan besvarade av efterforskningen —
kontrollera bara att ditt mejl stämmer. De tre sista är de obesvarade.

1. **`From:`** — ska vara `<något>+<slump>@facebookmail.com`. Är domänen en
   annan, lägg till den i `FB_DOMANER`.
2. **Länken** — sök efter `facebook.com/n/?` eller `/nd/?`. Klistra in den i
   `plockaInlaggsId()` och se att du får `<gid>_<postid>`.
3. **`n_m=`** — bekräfta att din egen mejladress står där, och att den är borta
   ur `fbmejl_ko.brodtext` efter en riktig körning.
4. **`Subject:`** — vad står det egentligen? Trunkeras det med `...`? Skriv upp
   det, det är den enda kvarvarande stora luckan.
5. **Inläggstexten** — finns den i brödtexten? I `text/plain` eller bara
   `text/html`? Hela texten eller ett sammandrag?
6. **Foten** — lägg till dess fraser i `SKRAPRADER`.

Notera också **grupp-id:t** ur länken och sätt det som `FB_GRUPP_ID` för
edge-funktionen. Gruppfilter på id är oändligt mycket säkrare än på namn.

Klistra sedan in det du hittat i `fbmejl-test.html` som ett nytt test med den
riktiga texten, och rätta mönstren tills det blir grönt. **Lägg till
`fbmejl-prov/` i `.gitignore` först** — filerna innehåller andra människors
namn och text.

---

## När det inte funkar

```sql
select * from public.fbmejl_halsa;
```

| Symptom | Betyder | Gör |
|---|---|---|
| `minuter_sedan_koring` högt | Pollaren går inte | Sover datorn? Finns uppgiften kvar i Schemaläggaren? |
| `mejl_dygn` = 0 | Inga mejl kommer | Steg 3. Kolla brevlådan för hand. |
| `liggande_i_ko` växer | Ingen tolkar kön | `fbmejl-tom` är inte utrullad eller inte schemalagd |
| `fastnade` > 0 | Formatfel | `select amne, brodtext from fbmejl_ko where forsok >= 5` |
| `rapporter_dygn` = 0 men kön töms | Tolkningen kastar allt | Formatet. Se *Verifiera*. |
| `notis_fel` > 0 | Notiskedjan trasig | `notis_senaste_fel` säger vad |
| `notiser_kvitterade_dygn` = 0, `sparrade_dygn` högt | Spärrarna gör sitt jobb | Inget fel. Justera värdena om du vill. |
| `ingen_mottagare_dygn` högt | Ingen har slagit på gruppnotiser | Se *Slå på dem*. Ingen push skickas alls då. |
| `notiser_koade_dygn` högt men `notiser_kvitterade_dygn` = 0 | Pushen köas men edge-funktionen svarar aldrig | `fbmejl-push` inte utrullad, eller fel nyckel. Kör `select public.fbmejl_notis_stam_av();` |
| `gruppnotis_mottagare` = 0 | Ingen har slagit på det | Se *Slå på dem* |

Gick en omgång fel och la ut skräp? Sista blocket i `supabase/fbmejl.sql`
släcker den utan att radera historiken.

---

## De tre spåren, rakt

### Userscript — `tools/fb-bridge.user.js`

Läser gruppen i webbläsaren som en inloggad människa.

**För:** ingen annan behöver vilja något. Ser exakt vad som står i gruppen,
med tidsstämpel och inläggs-id. Ingen fördröjning alls.

**Mot:** **det bryter mot Metas villkor.** Automatiserad läsning av inloggat
innehåll är precis det de förbjuder, och priset är kontot — inte en varning.
Det slutar dessutom fungera var gång Facebook byter klassnamn i sin DOM, vilket
sker utan förvarning och utan att något syns förrän någon undrar varför det
blivit tyst. Kräver en öppen webbläsare med en inloggad session.

**Använd om:** aldrig i drift. Möjligen för att en kväll läsa ut historiken och
se hur många inlägg gruppen faktiskt ger — alltså för att avgöra om något av de
andra två spåren är värt att bygga.

### Telegram-spegeln — `docs/telegram-brygga.md`

En gruppadmin postar samma sak i en Telegram-kanal. Vi läser kanalen med
Telegrams riktiga bot-API.

**För:** helt inom alla villkor, hos alla inblandade. Stabilt API som inte
ändras. Long polling ger fördröjning på sekunder. Meddelandena bär `date` och
`forward_date`, alltså riktig tid per inlägg. Kan bära en kartnål (`location`),
vilket är bättre än varje geokodat gatunamn. Kör i molnet — ingen dator hemma
behöver vara igång.

**Mot:** **det börjar med att en annan människa måste vilja.** Varje dag, för
alltid. Slutar admin orka slutar bryggan, och det finns ingenting du kan göra
åt det. Speglingen är också ofullständig — den som postar i båda gör det när
hen kommer ihåg.

**Använd om:** admin säger ja. Då är det bäst av de tre, utan konkurrens.

### Mejlnotiserna — den här filen

Facebook mejlar dig själv. Vi läser din postlåda.

**För:** **ingen annan människa behöver vilja något.** Det är den enda av de
tre där du råder över hela kedjan. Helt inom villkoren — det är dina egna
notiser till din egen adress. Fungerar även om admin aldrig svarar. Går i drift
på en eftermiddag.

**Mot:** **Facebook bestämmer vad du får veta.** Det finns inget e-postval på
gruppnivå, och algoritmen väljer vilka inlägg som aviseras — täckningen är
alltså inte din att styra, och den kan ändras utan förvarning. Formatet är
delvis odokumenterat. Buntningen kan sänka latenskravet helt. Vi ser Facebooks
*sammandrag* av inlägget, trunkerat. Tiden är när mejlet skickades, inte när
inlägget skrevs. Pollaren kräver att en Windows-maskin är igång. Postlådan är
en angreppsyta (se DKIM ovan).

**Använd om:** täckningsmätningen i steg 0 ser vettig ut, och admin inte
svarat — eller som andra ben bredvid Telegram.

### Sammanfattat

| | Userscript | Telegram | Mejl |
|---|---|---|---|
| Kräver annan människa | nej | **ja** | nej |
| Inom villkoren | **nej** | ja | ja |
| **Ser du ALLA inlägg?** | **ja** | ja, om admin speglar allt | **nej — algoritmen väljer** |
| Fördröjning | sekunder | sekunder | sekunder–minuter, **eller aldrig om det buntas** |
| Format stabilt | nej | **ja** | delvis |
| Riktig tid per inlägg | ja | **ja** | nej (mejlets tid) |
| Kartnål möjlig | nej | **ja** | nej |
| Kör i molnet | nej | **ja** | nej (Windows-maskin) |
| Går att sätta upp idag | ja | nej | **ja** |

### Rekommendation

**Fråga admin om Telegram. Mät mejltäckningen medan du väntar.**

Efterforskningen flyttade tyngdpunkten här. Mejlbryggan är fortfarande den enda
vägen som inte kräver att en annan människa vill något — men den kräver i
stället att **Facebooks algoritm** vill något, och det är en sämre affär. Ett
spår där du inte styr täckningen kan inte vara ryggraden i en varningstjänst.

Så:

1. **Slå på kontots e-postaviseringar idag och räkna i ett dygn.** Det kostar
   ingenting och avgör allt.
2. **Fråga admin om Telegram parallellt.** Det är fortfarande det bästa spåret
   och blir det ännu tydligare nu: där ser du varje inlägg som speglas, med
   riktig tid och ibland en kartnål.
3. **Bygg mejlkedjan bara om täckningen håller.** Gör den det är den ett bra
   andra ben — den kostar ingenting att ha kvar när Telegram kommer:
   **textnyckeln är identisk i båda** (`tx:<hash>:<fack>`, samma FNV-1a, samma
   treTimmarsfönster), och `fbmejl_ta_emot()` slår upp i `telegram_lasta` innan
   den skapar något. Samma inlägg båda vägarna blir **en** varning.

Userscriptet ska inte köras i drift. Punkt.

---

## Vad som INTE är löst

- **Täckningen är okänd och inte vår att styra.** Facebook aviserar bara om
  inlägg algoritmen väljer, och det finns inget e-postval på gruppnivå. Detta
  är den största olösta frågan i hela spåret — mät den först.
- **Ämnesradens format är overifierat.** Avsändaren och länken är belagda;
  ämnesraden gick inte att belägga en enda gång.
- **Buntningen är okänd.** Hur ofta Facebook buntar, och därmed om
  minutkravet håller, går inte att veta utan att köra i en vecka.
- ~~**`fbmejl-tom` och `fbmejl-push` finns inte.**~~ Rättat 20 aug 2026 —
  båda ligger i `supabase/functions/`. Kvar: de är inte utrullade, och
  schemat i dashboarden måste sättas med
  `Authorization: Bearer <service_role_key>` (eller `x-cron-secret` för
  tom-funktionen), annars 401.
- **`kvitterad` betyder inte att notisen syntes.** Den betyder att
  edge-funktionen svarade 2xx. Ingenting i kedjan mäter om en telefon
  faktiskt ritade något — det kräver en kvittens från `sw.js`.
- ~~**Appen har ingen knapp för gruppnotiser.**~~ Rättat 20 aug 2026:
  `sattGruppnotiser()`/`harGruppnotiser()` finns i `js/push.js`, reglaget
  `setGruppnotiser` i `index.html`, och det gråas ut med en riktig förklaring
  när notiser inte går att få. Kvar: `harGruppnotiser()` läser localStorage,
  inte servern, trots vad kommentaren intill den påstår.
- **Ingen automatisk larmning.** `fbmejl_halsa` svarar på frågan, men bara om
  någon ställer den.
- **Pollaren dör med datorn.** Ingen övervakning säger till.
