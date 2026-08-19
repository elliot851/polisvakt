# Telegram-bryggan

Vägen in från Facebook-gruppen "Här står polisen" till varningar på kartan.

Mottagarsidan i appen är redan klar. Det som saknas är flödet in, och den här
guiden är hela det arbetet.

---

## Det ärliga först: en människa måste vilja

**Det finns ingen teknisk lösning på steg 1.** Meta stängde Groups API för
inläggsläsning 2024. Allt som automatiskt kopierar en Facebook-grupp måste
logga in som en människa och läsa gruppen, och då bryter det mot Metas villkor
— det gäller Zapier, Make, varje "no-code"-tjänst som påstår något annat, och
userscriptet i `tools/fb-bridge.user.js`. Zapier och Make kan bara läsa
Facebook-**sidor**, aldrig grupper.

Så bryggan börjar med ett samtal, inte med kod. Någon som redan är med i
gruppen måste posta samma sak i en Telegram-kanal. Resten av den här guiden är
ungefär trettio minuter.

Tre sätt, bäst först:

**A. Gruppens admin startar en Telegram-kanal.** Fråga rakt ut. Argumentet som
brukar landa: Facebook visar inte inläggen i tid — algoritmen sorterar, och en
varning som dyker upp fyrtio minuter senare är värdelös. Telegram pushar direkt
till alla. Erbjud dig att sätta upp kanalen och sköta den; för admin blir det
mer räckvidd, inte mer arbete.

**B. Ett par medlemmar speglar.** Skapa en egen Telegram-grupp, bjud in de
fem–tio som postar mest i Facebook-gruppen, be dem posta i båda.
Vidarebefordrade meddelanden fungerar lika bra — boten läser texten, och
`forward_date` gör att varningen räknas från när originalet skrevs.

**C. Låt appen bli kanalen.** Rapportknappen och rösten är snabbare än att
skriva ett Facebook-inlägg under körning. Får du folk att rapportera i appen
behövs varken Facebook eller Telegram. Det är slutmålet ändå.

Boten läser både grupper och kanaler. Kanal är bättre om bara några få ska få
posta, grupp om alla ska kunna det.

---

## 1. Skapa boten

I Telegram, sök upp **@BotFather**:

1. `/newbot`
2. Visningsnamn, t.ex. `Polisvakt Västmanland`
3. Användarnamn, måste sluta på `bot`: `polisvakt_vastmanland_bot`

Du får en token som ser ut som `8123456789:AAG-x9tK...`. **Den är ett
lösenord.** Den som har den kan läsa allt boten ser och skriva i dess namn.
Den ska aldrig i något läge ligga i appens källkod eller i git — appens
JavaScript är öppet för vem som helst som trycker "visa källa". Därför pollas
boten på serversidan, i en edge-funktion, och därför finns det ingen token
någonstans i `js/telegram.js`.

Ångrar du dig: `/revoke` i BotFather ger en ny token och dödar den gamla.

### Är det en grupp

Botar har **integritetsläge påslaget** som standard och ser då bara kommandon
och svar riktade till dem:

1. `/mybots` → välj boten → **Bot Settings** → **Group Privacy** → **Turn off**
2. **Lägg till boten i gruppen EFTER att du stängt av det.** Ändringen slår
   inte igenom i grupper boten redan är med i — den måste tas bort och läggas
   till igen.

Det här är den vanligaste anledningen till att allt ser rätt ut men ingenting
kommer in.

### Är det en kanal

Lägg till boten som **administratör**. Utan admin får den inga uppdateringar
alls. Kanalinlägg kommer som `channel_post`, inte `message` — bryggan lyssnar
på båda, plus redigerade inlägg.

### Hitta chattens id

Skriv något i kanalen och öppna i webbläsaren:

```
https://api.telegram.org/bot<DIN_TOKEN>/getUpdates
```

Leta upp `"chat":{"id":-1001234567890,...}`. Kanaler och supergrupper har
negativa id som börjar på `-100`. Spara det — utan det läser boten allt den
råkar bli tillagd i.

Tomt svar fast du precis skrivit? Se integritetsläget ovan. `409 Conflict`?
Två saker pollar samma bot samtidigt. Har boten någon gång haft en webhook
måste den bort först, webhook och `getUpdates` utesluter varandra:

```
https://api.telegram.org/bot<DIN_TOKEN>/deleteWebhook
```

---

## 2. Databasen

Kör i Supabase SQL Editor, i den här ordningen om något saknas:

1. `supabase/schema.sql`
2. `supabase/kvalitetsfalt.sql`
3. `supabase/facebook.sql`
4. `supabase/telegram.sql`  ← den nya

`telegram.sql` säger ifrån direkt om `kvalitetsfalt.sql` inte är körd, istället
för att gå sönder senare vid första riktiga inlägget.

Den lägger till:

| | |
|---|---|
| `telegram_lasta` | vilka meddelanden som redan är avgjorda — avdubblingen |
| `telegram_brygga` | var pollningen står, och när den senast gick |
| `telegram_ta_emot(jsonb)` | tar emot färdigtolkade rader, skapar rapporter |
| `telegram_offset()` / `telegram_satt_offset()` | kvitterar pollningen |
| `telegram_ar_nykterhetskontroll(text)` | sista nätet, se nedan |
| `telegram_senaste`, `telegram_halsa` | revisionsvyer för SQL-editorn |

Alla tabeller har radsäkerhet påslagen **utan policyer**, och alla funktioner
är åtkomliga bara för `service_role`. Det betyder att appens publika nyckel
inte kan läsa, skriva eller anropa någonting av det här. Det är avsiktligt:
`telegram_ta_emot` skriver förbi radsäkerheten, och kunde vem som helst anropa
den vore hela insert-policyn på `reports` meningslös.

Kör kontrollfrågorna längst ner i `supabase/telegram.sql` när du är klar. De
tar en minut och visar att rättigheterna faktiskt blev som de ska.

---

## 3. Hemligheter i Supabase

Dashboard → **Edge Functions** → **Secrets** (eller
`supabase secrets set NAMN=värde`):

| Namn | Värde |
|---|---|
| `TELEGRAM_TOKEN` | token från BotFather |
| `TELEGRAM_CHAT_ID` | `-1001234567890` — kanalens id |

`SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY` sätts automatiskt i varje
edge-funktion; du behöver inte lägga in dem.

Service role-nyckeln får bara finnas här, på servern. Aldrig i appen, aldrig i
git.

---

## 4. Pollaren

Skapa `supabase/functions/telegram-poll/index.ts` med innehållet nedan och
rulla ut den:

```bash
supabase functions deploy telegram-poll --no-verify-jwt
```

`--no-verify-jwt` behövs bara om du vill kunna trigga den från Dashboardens
schemaläggare utan att skicka en JWT. Kör du via pg_cron med
`Authorization: Bearer <service role>` kan du utelämna flaggan.

Funktionen är avsiktligt tunn. All bedömning ligger i `js/telegram.js`, som
den hämtar från den utrullade appen — samma fil som webbläsarna kör, som i sin
tur anropar samma `js/parser.js` som rösten och knapparna. Ändrar du en regel
i parsern gäller den i bryggan vid nästa körning, utan utrullning. Priset är
att en trasig utrullning av appen också blir en trasig brygga; är det ett
problem kan du frysa en version genom att lägga en kopia av modulerna i
funktionsmappen och importera dem relativt istället.

```ts
// supabase/functions/telegram-poll/index.ts
//
// Pollar Telegram-spegeln av Facebook-gruppen och lämnar färdiga rader till
// public.telegram_ta_emot(). All tolkning sker i js/telegram.js -> js/parser.js.

import { bearbeta, telegramUrl, summeringText }
  from 'https://polisvakt.netlify.app/js/telegram.js';

const TOKEN   = Deno.env.get('TELEGRAM_TOKEN')!;
const CHAT    = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';
const SUPA    = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const APP = 'https://polisvakt.netlify.app';
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

// Aliaslistan hämtas från appen så slang och smeknamn bara finns på ett
// ställe: data/aliases.vasteras.json.
let alias: Record<string, string> | null = null;
const cache = new Map<string, unknown>();
let sistaUppslag = 0;

async function geokoda(plats: string) {
  const nyckel = plats.toLowerCase().trim();
  if (cache.has(nyckel)) return cache.get(nyckel);
  if (!alias) {
    alias = await fetch(`${APP}/data/aliases.vasteras.json`)
      .then(r => r.json()).catch(() => ({}));
  }
  const fraga = alias![nyckel] ?? plats;

  // Nominatim tillåter ett anrop per sekund. Kön är enkel men räcker: en
  // pollning gör sällan mer än ett par uppslag.
  const vanta = 1100 - (Date.now() - sistaUppslag);
  if (vanta > 0) await new Promise(r => setTimeout(r, vanta));
  sistaUppslag = Date.now();

  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', /västerås|västmanland/i.test(fraga) ? fraga : `${fraga}, Västerås`);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'se');
  u.searchParams.set('viewbox', VIEWBOX.join(','));
  u.searchParams.set('bounded', '1');           // aldrig en träff utanför länet
  u.searchParams.set('accept-language', 'sv');

  const rader = await fetch(u, {
    headers: { 'User-Agent': 'Polisvakt/1.0 (telegram-poll; polisvakt.se)' },
  }).then(r => r.json()).catch(() => []);

  const traff = rader?.[0]
    ? { lat: parseFloat(rader[0].lat), lon: parseFloat(rader[0].lon),
        label: String(rader[0].name || plats), source: 'nominatim' }
    : null;
  cache.set(nyckel, traff);          // även nej cachas, annars frågar vi om
  return traff;
}

Deno.serve(async () => {
  try {
    const offset = await rpc('telegram_offset');

    // timeout=20: Telegram håller anslutningen öppen tills något händer, så
    // varningen kommer fram sekunder efter att den postats istället för att
    // vänta på nästa schemalagda körning.
    const svar = await fetch(
      telegramUrl(TOKEN, 'getUpdates', {
        offset: Number(offset) + 1,
        timeout: 20,
        allowed_updates: ['message', 'channel_post',
                          'edited_message', 'edited_channel_post'],
      }),
    ).then(r => r.json());

    if (!svar.ok) throw new Error(`Telegram: ${svar.error_code} ${svar.description}`);

    // sedda är tom vid varje anrop, med flit. Edge-funktioner har inget minne
    // mellan körningar — den riktiga avdubblingen sitter i telegram_lasta och
    // i unique-villkoret på reports.external_id. Mängden här fångar bara
    // dubbletter inom samma omgång.
    const s = await bearbeta(svar.result, { geokoda, chatId: CHAT || null });

    let db = null;
    if (s.rapporter.length) db = await rpc('telegram_ta_emot', { p_rader: s.rapporter });
    if (s.sistaUpdateId != null) {
      await rpc('telegram_satt_offset', { p_offset: s.sistaUpdateId });
    }

    console.log(summeringText(s), JSON.stringify(db));
    return Response.json({ ok: true, brygga: s.bortsorterade, databas: db,
                           okandaPlatser: s.okandaPlatser });
  } catch (e) {
    await rpc('telegram_satt_offset', { p_offset: 0, p_fel: String(e.message) })
      .catch(() => {});
    console.error(e);
    return Response.json({ ok: false, fel: String(e.message) }, { status: 500 });
  }
});
```

---

## 5. Schemaläggning

Två vägar. Välj en.

**Dashboard (enklast).** Edge Functions → telegram-poll → Schedules → varannan
minut.

**pg_cron + pg_net (allt i databasen).** Sätt de två inställningarna och kör
`supabase/telegram.sql` igen — den schemalägger sig själv när adressen finns:

```sql
alter database postgres set app.service_role_key   = 'eyJ...';
alter database postgres set app.telegram_poll_url  = 'https://<projekt>.supabase.co/functions/v1/telegram-poll';
```

Nycklarna får inte stå i klartext i `cron.job` — den tabellen är läsbar för
alla med databasåtkomst och följer med i varje backup. Därför inställningar och
inte inklistrade strängar.

Städningen av `telegram_lasta` schemaläggs automatiskt till 04:50 om pg_cron
finns.

**Kör bara en pollare.** Två samtidiga `getUpdates` mot samma token ger
`409 Conflict` och båda tappar meddelanden. Har du testat det gamla
Node-skriptet i `tools/telegram-bridge.md` lokalt: stäng ner det först.

---

## 6. Kontrollera att det funkar

```sql
select * from telegram_halsa;      -- går bryggan? när kördes den senast?
select * from telegram_senaste;    -- vad kom in senaste dygnet
select * from facebook_quality;    -- hur mycket röstas ner, per dag
```

Fungerar-listan, i ordning:

1. `telegram_halsa.senast_kord` uppdateras → schemaläggningen går.
2. `lasta_dygn` växer → boten ser kanalen. Gör den inte det: integritetsläget,
   eller boten är inte admin i kanalen.
3. `rapporter_dygn` växer → tolkningen fungerar. Är `lasta_dygn` stort men
   `rapporter_dygn` noll skrivs det saker i kanalen som inte är polisvarningar,
   eller så hittar geokodningen inte platserna — se `okandaPlatser` i
   funktionens svar.
4. `nedrostade_veckan` — den enda ärliga kvalitetsmätaren. Ingen orkar
   rapportera att en varning stämde, men falska varningar röstas ner direkt.
   Kryper andelen över ungefär 15 % är det parsern eller geokodningen som
   brister, inte användarna. Höj `MIN_TILLIT` i `js/telegram.js` innan du ändrar
   något annat.

Platser som ständigt blir fel hör hemma i `data/aliases.vasteras.json`. Jämför
`plats` mot `inlagg` i `telegram_senaste`: blir "Erikslund" en parkering i Sala
har Nominatim gissat, och ett alias löser det för alltid.

---

## Hur en varning märks

Rapporterna får `source = 'facebook'` och `device_id = 'tg-bridge'`.

Källan är alltså **inte** `'telegram'`, och det är ett medvetet val med tre
skäl som pekar åt samma håll:

- Det *är* gruppens inlägg. Telegram är transporten, inte källan.
- `schema.sql` tillåter bara `app`, `voice`, `facebook` och `import`. Ett femte
  värde är en migrering på en tabell som är i drift.
- `js/kvalitet.js` graderar efter källa: `facebook` 0,42 och okänd 0,45. Ett
  `'telegram'` som inte står i den listan skulle tyst räknas som **mer**
  pålitligt än ett Facebook-inlägg. Samma text, högre betyg, bara för att den
  tog en annan väg in. Det vore en lögn i graderingen.

Att skilja Telegram-bryggan från userscriptet går ändå: `device_id` är
`tg-bridge` och `external_id` börjar på `tg:`. Vyn `telegram_senaste` filtrerar
på just det.

Vill du ändå ha `source = 'telegram'` måste tre saker göras i samma ändring:
check-villkoret på `reports.source`, `BAS_KALLA` i `js/kvalitet.js` (sätt den
till 0,42 eller lägre) och `KALLA` i `js/telegram.js`. Görs bara två av tre blir
grupprapporterna tyst uppgraderade.

---

## Vad bryggan medvetet inte gör

- **Rapporterar aldrig nykterhets- eller drogkontroller.** Regeln sitter i
  `js/parser.js` och gäller alla vägar in. `js/telegram.js` kontrollerar den en
  extra gång innan parsern, och `telegram_ar_nykterhetskontroll()` i databasen
  är ett tredje, grövre nät. De två extra kan bara avvisa mer, aldrig släppa
  igenom mer. Ta inte bort något av dem.
- **Rapporterar aldrig fartkameror.** De 136 kamerorna i Västmanland ligger
  redan i appen med rätt position och mätriktning. En handmarkerad kamera
  hamnar några hundra meter fel, och det är sämre än ingen markering alls.
- **Släcker inga varningar.** "Nu är dom borta" känns igen men används inte —
  vi vet inte vilken rapport det gäller, och att släcka fel varning är värre än
  att låta den löpa ut om en halvtimme.
- **Läser inga bilder.** Ett fotograferat inlägg utan bildtext ger ingenting.
  Bildtext (caption) läses däremot.
- **Lägger aldrig ut en varning som redan hunnit löpa ut.** Ett inlägg som
  legat i kanalen i tre timmar är inte en ny varning.
- **Gissar inte.** Under 0,65 i tolkningssäkerhet, eller en plats som inte går
  att slå upp i Västmanland, blir ingen rapport. En falsk varning är värre än
  ingen varning alls — efter två slutar föraren lita på appen.

---

## Det gamla skriptet

`tools/telegram-bridge.md` innehåller en fristående Node-version med en
**kopia** av parserns ordlistor. Den fungerar, men kopian är hela problemet:
två nykterhetsfilter som ska hållas i synk för hand glider isär förr eller
senare, och det ena av dem varnar folk för poliser som letar rattfyllerister.

Kör den bara om du snabbt vill se om kanalen levererar något alls. Den riktiga
vägen är den här filen.
