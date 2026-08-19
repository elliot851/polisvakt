# Telegram-bryggan

Den hållbara vägen in från "Här står polisen" till Polisvakt.

Meta stängde Groups API för inläggsläsning 2024. Userscriptet i
`fb-bridge.user.js` går runt det genom att läsa din egen inloggade webbläsare —
det fungerar, men bryter mot Metas villkor, kräver en öppen flik och dör så
fort datorn somnar.

Telegram har ett riktigt bot-API som är byggt för precis det här. Ingen
villkorsrisk, ingen öppen flik, körs dygnet runt på vad som helst som kan köra
Node. Det som krävs är att inläggen finns i Telegram, och det är det enda
riktiga arbetet i hela den här guiden — resten är tjugo minuter.

---

## 1. Få inläggen till Telegram

Det finns ingen teknisk genväg här. Allt som automatiskt kopierar en
Facebook-grupp till Telegram måste läsa Facebook, och då är du tillbaka i
samma villkorsproblem. Zapier och Make kan bara läsa Facebook-**sidor**, inte
grupper. Så det här är ett människoproblem, inte ett kodproblem.

Tre varianter, bäst först:

**A. Gruppens admin startar en Telegram-kanal.** Fråga rakt ut. Argumentet som
brukar landa: Facebook visar inte inläggen i tid — algoritmen sorterar, och en
varning som dyker upp fyrtio minuter senare är värdelös. Telegram pushar direkt
till alla. Erbjud dig att sätta upp kanalen och sköta den.

**B. Ett par medlemmar vidarebefordrar.** Skapa en egen Telegram-grupp, bjud in
de fem–tio som postar mest i Facebook-gruppen och be dem posta i båda.
Vidarebefordrade meddelanden fungerar precis lika bra för boten — texten följer
med.

**C. Låt appen bli kanalen.** Rapportknappen och rösten i Polisvakt är snabbare
än att skriva ett Facebook-inlägg under körning. Får du folk att rapportera i
appen behövs varken Facebook eller Telegram. Det här är slutmålet ändå.

Boten läser både **grupper** och **kanaler**. Kanal är bättre om bara några få
ska få posta, grupp är bättre om alla ska kunna det.

---

## 2. Skapa boten

I Telegram, sök upp **@BotFather** och kör:

1. `/newbot`
2. Visningsnamn, till exempel `Polisvakt Västmanland`.
3. Användarnamn, måste sluta på `bot`: `polisvakt_vastmanland_bot`.

Du får en token som ser ut som `8123456789:AAG-x9tK...`. **Den är ett lösenord.**
Den som har den kan läsa allt boten ser och skriva i dess namn. Lägg den aldrig
i git — den ska ligga i en miljövariabel.

Ångrar du dig: `/revoke` i BotFather ger en ny token och dödar den gamla.

### Om det är en grupp

Botar har **integritetsläge påslaget** som standard och ser då bara
kommandon (`/något`) och svar riktade till dem. En bot som ska läsa allt i en
grupp måste ha det avstängt:

1. `/mybots` → välj boten → **Bot Settings** → **Group Privacy** → **Turn off**
   (samma sak nås med `/setprivacy`).
2. **Lägg till boten i gruppen efter att du stängt av det.** Ändringen slår
   inte igenom i grupper boten redan är med i — den måste tas bort och läggas
   till igen. Det här är den vanligaste anledningen till att `getUpdates`
   returnerar en tom lista trots att folk skriver.

### Om det är en kanal

Lägg till boten som **administratör** i kanalen. Utan admin får den inga
uppdateringar alls. Inlägg i kanaler kommer som `channel_post`, inte `message`
— skriptet nedan lyssnar på båda.

### Hitta chattens id

Skriv något i gruppen eller kanalen och öppna sedan i webbläsaren:

```
https://api.telegram.org/bot<DIN_TOKEN>/getUpdates
```

Leta upp `"chat":{"id":-1001234567890,...}`. Supergrupper och kanaler har
negativa id som börjar på `-100`. Spara det som `TELEGRAM_CHAT_ID` så att
boten ignorerar allt annat den råkar bli tillagd i.

Får du `{"ok":true,"result":[]}` fast du precis skrivit: se integritetsläget
ovan. Får du `409 Conflict`: skriptet körs redan någon annanstans, två
`getUpdates` mot samma token samtidigt går inte. Har boten någon gång haft en
webhook måste den bort först, `getUpdates` och webhook utesluter varandra:

```
https://api.telegram.org/bot<DIN_TOKEN>/deleteWebhook
```

---

## 3. Skriptet

Node 18 eller senare (behöver inbyggda `fetch`). Inga beroenden, en fil.

Spara som `telegram-bridge.mjs`, kör med:

```bash
export TELEGRAM_TOKEN='8123456789:AAG-x9tK...'
export TELEGRAM_CHAT_ID='-1001234567890'
export SUPABASE_URL='https://livvehyqowmcafnisxho.supabase.co'
export SUPABASE_KEY='sb_publishable_6Oz7vhMd2b-kWB_DVftsmg_VwclVG5Q'
export DRY_RUN=1                  # ta bort när du sett att rätt saker plockas
node telegram-bridge.mjs
```

På Windows, i PowerShell:

```powershell
$env:TELEGRAM_TOKEN='8123456789:AAG-x9tK...'
$env:TELEGRAM_CHAT_ID='-1001234567890'
$env:SUPABASE_URL='https://livvehyqowmcafnisxho.supabase.co'
$env:SUPABASE_KEY='sb_publishable_6Oz7vhMd2b-kWB_DVftsmg_VwclVG5Q'
$env:DRY_RUN='1'
node telegram-bridge.mjs
```

Nyckeln ovan är Polisvakts publishable-nyckel. Den är byggd för att ligga
öppet i klientkod och ger bara det radsäkerhetsreglerna i
`supabase/schema.sql` tillåter. **Använd aldrig service role-nyckeln här** —
skriptet behöver den inte, och en server som står och pollar är precis fel
ställe att ha en nyckel som går förbi alla regler.

```js
// Polisvakt — Telegram-brygga
//
// Long-pollar en Telegram-grupp eller kanal och gör om polisvarningar till
// rapporter i Polisvakt. Node 18+, inga beroenden.
//
// Reglerna här är avsiktligt en kopia av js/parser.js i appen. Skriptet körs
// på en server utan tillgång till appens moduler, men ordlistorna måste hållas
// i synk — särskilt nykterhetsfiltret, som är en produktregel och inte en
// inställning.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/* ================= Konfiguration ================= */

const TOKEN    = process.env.TELEGRAM_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID || '';    // tomt = alla chattar
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;
const DRY_RUN  = process.env.DRY_RUN === '1';

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.65);
const STATE_FILE = process.env.STATE_FILE || './polisvakt-state.json';
const USER_AGENT = 'Polisvakt/1.0 (telegram-bridge; polisvakt.se)';

const TTL_MINUTES = { police: 45, control: 60, unmarked: 30 };
const VIEWBOX = [15.10, 59.30, 17.30, 60.30];           // Västmanland

if (!TOKEN || !SUPA_URL || !SUPA_KEY) {
  console.error('Sätt TELEGRAM_TOKEN, SUPABASE_URL och SUPABASE_KEY först.');
  process.exit(1);
}

/* ================= Parser (kopia av js/parser.js) ================= */

const TYPE_WORDS = [
  // ordning spelar roll: mest specifik först
  { type: 'camera',   words: ['fartkamera', 'fartkameror', 'atk', 'trafiksäkerhetskamera', 'kamera'] },
  { type: 'control',  words: ['trafikkontroll', 'fartkontroll', 'hastighetskontroll',
                              'laserkontroll', 'poliskontroll', 'kontroll', 'razzia', 'laser'] },
  { type: 'unmarked', words: ['civilbil', 'civilbilar', 'civilpolis', 'civilpoliser', 'civil polis',
                              'civila bilar', 'civil', 'civila'] },
  { type: 'police',   words: ['polis', 'polisen', 'poliser', 'polisbil', 'polisbilar', 'snut', 'snutar',
                              'snuten', 'blåljus', 'piket', 'mc-polis', 'motorcykelpolis'] },
];
const ALL_TYPE_WORDS = new Set(TYPE_WORDS.flatMap(g => g.words.flatMap(w => w.split(' '))));

const CLEAR_WORDS = ['borta', 'åkte', 'åkt', 'iväg', 'försvunnit', 'försvann', 'fritt',
                     'lugnt', 'avblåst', 'packat', 'tomt'];

// Nykterhets- och drogkontroller rapporteras aldrig. Att varna för en
// fartkamera hjälper någon att hålla hastigheten. Att varna för en
// nykterhetskontroll hjälper någon att köra vidare full.
const SOBRIETY_WORDS = [
  'nykterhetskontroll', 'nykterhetskontroller', 'nykterhet', 'nykter',
  'alkoholkontroll', 'alkotest', 'alkoholtest', 'blåsa', 'blåser', 'blås',
  'utandningsprov', 'promillekontroll', 'rattfylla', 'rattfyllerikontroll',
  'sållningsprov', 'drogkontroll', 'drogtest',
];

const NOISE_PHRASES = ['någon som vet', 'vet någon', 'stämmer det', 'är det någon kvar',
                       'säljes', 'köpes', 'bortsprungen', 'efterlyst', 'grattis'];
const NOISE_WORDS = ['tack', 'tackar', 'okej', 'grattis', 'säljes', 'köpes', 'katt', 'hund'];

const STOPWORDS = new Set([
  'vid', 'på', 'i', 'utanför', 'mot', 'runt', 'kring', 'nere', 'uppe', 'bakom', 'framför', 'från',
  'står', 'stod', 'sitter', 'satt', 'ligger', 'finns', 'är', 'var', 'nu', 'just', 'precis', 'åt', 'håll',
  'en', 'ett', 'den', 'det', 'de', 'dom', 'och', 'samt', 'med', 'har', 'hade', 'ser', 'såg', 'kvar',
  'varning', 'varnar', 'obs', 'info', 'tips', 'akta', 'se', 'upp', 'kolla', 'observera', 'pass',
  'nyss', 'sedan', 'sen', 'igen', 'också', 'även', 'typ', 'ca', 'cirka', 'ungefär', 'liksom',
  'gubbarna', 'gubbar', 'grabbar', 'killar', 'folk', 'någon', 'nån', 'dem', 'dej', 'er', 'oss',
]);

const DIRECTION_HINTS = new Set(['norrut', 'söderut', 'österut', 'västerut', 'infart', 'avfart',
  'påfart', 'avfarten', 'påfarten', 'rondellen', 'rondell', 'korsningen', 'bron', 'rampen']);

const NOT_A_PLACE = new Set([
  ...CLEAR_WORDS, 'ihop',
  'hej', 'hallå', 'okej', 'vakt', 'hey',
  'mörk', 'mörkblå', 'ljus', 'vit', 'svart', 'grå', 'blå', 'röd', 'silver',
  'bil', 'bilen', 'skåpbil', 'volvo', 'passat', 'golf', 'bmw', 'audi', 'buss',
]);

const normalize = s => (s || '').toLowerCase()
  .replace(/[^\wåäöéèü\s-]/g, ' ').replace(/\s+/g, ' ').trim();

function parseReportText(raw) {
  const text = normalize(raw);
  if (!text || text.length < 3) return null;

  const words = text.split(' ');
  if (SOBRIETY_WORDS.some(w => words.includes(w) || text.includes(w))) {
    return { intent: 'refused', reason: 'sobriety' };
  }

  let t = null;
  outer:
  for (const g of TYPE_WORDS) {
    for (const w of g.words) {
      if (w.includes(' ') ? text.includes(w) : words.includes(w)) { t = g.type; break outer; }
    }
  }
  if (!t) return null;

  // Fartkamerorna finns redan i appen med rätt koordinat och mätriktning.
  if (t === 'camera') return { intent: 'refused', reason: 'camera' };

  if (NOISE_PHRASES.some(p => text.includes(p))) return null;
  if (NOISE_WORDS.some(w => words.includes(w)) && words.length < 5) return null;

  const intent = CLEAR_WORDS.some(w => words.includes(w)) ? 'clear' : 'report';

  const place = words.filter(w =>
    !ALL_TYPE_WORDS.has(w) && !STOPWORDS.has(w) && !NOT_A_PLACE.has(w) &&
    !/^\d{1,2}[:.]\d{2}$/.test(w) && !(/^\d+$/.test(w) && w.length > 3)
  ).join(' ').trim();

  let confidence = 0.5;
  if (place.length >= 3) confidence += 0.3;
  if (words.length <= 8) confidence += 0.1;
  else if (words.length > 25) confidence -= 0.2;
  if (t === 'control') confidence += 0.05;
  if (words.some(w => DIRECTION_HINTS.has(w))) confidence += 0.05;

  return { intent, type: t, place, confidence: Math.max(0, Math.min(1, confidence)) };
}

/* ================= Tillstånd på disk ================= */
//
// Två saker måste överleva en omstart: vilket update_id vi kommit till (annars
// spelas hela kön om och gamla varningar dyker upp igen) och geokodnings-
// cachen (annars slår vi upp samma korsning tusen gånger hos Nominatim).

const state = (() => {
  const tom = { offset: 0, geo: {} };
  try { return { ...tom, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  catch { return tom; }
})();

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); }
    catch (e) { console.error('Kunde inte spara tillstånd:', e.message); }
  }, 500);
}

/* ================= Telegram ================= */

async function api(method, body, timeoutMs = 15000) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(`${method}: ${json.error_code} ${json.description}`);
    err.retryAfter = json.parameters?.retry_after;
    throw err;
  }
  return json.result;
}

/**
 * Long polling. timeout=50 betyder att Telegram håller anslutningen öppen i
 * upp till 50 sekunder och svarar direkt när något händer — nästan realtid
 * utan att hamra på API:et. HTTP-timeouten måste vara längre än så.
 */
async function getUpdates() {
  return api('getUpdates', {
    offset: state.offset,
    timeout: 50,
    allowed_updates: ['message', 'channel_post'],
  }, 60000);
}

/** Texten kan ligga i text (vanligt inlägg) eller caption (bild med text). */
function textOf(msg) {
  return (msg.text || msg.caption || '').trim();
}

/* ================= Geokodning ================= */

let lastGeocode = 0;

async function geocode(place) {
  const key = normalize(place);
  if (key in state.geo) return state.geo[key];

  // Nominatims användarvillkor: högst ett anrop per sekund och en User-Agent
  // som går att kontakta. Utan UA blockeras servern, ofta permanent.
  const wait = 1100 - (Date.now() - lastGeocode);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocode = Date.now();

  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', /västerås|västmanland/i.test(place) ? place : `${place}, Västerås`);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'se');
  u.searchParams.set('viewbox', VIEWBOX.join(','));
  u.searchParams.set('bounded', '1');
  u.searchParams.set('accept-language', 'sv');

  const res = await fetch(u, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const rows = await res.json();

  // Även nej cachas — annars slås samma okända plats upp om och om igen.
  const hit = rows.length
    ? { lat: parseFloat(rows[0].lat), lon: parseFloat(rows[0].lon),
        label: String(rows[0].name || place).slice(0, 120) }
    : null;
  state.geo[key] = hit;
  saveState();
  return hit;
}

/* ================= Supabase ================= */

// on_conflict + ignore-duplicates: samma meddelande kan komma in två gånger om
// skriptet startas om innan offset hunnit sparas. Databasen avgör, inte vi.
async function insertReport(row) {
  const res = await fetch(`${SUPA_URL}/rest/v1/reports?on_conflict=external_id`, {
    method: 'POST',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;    // false = fanns redan
}

/* ================= Ett meddelande ================= */

async function handle(msg) {
  if (CHAT_ID && String(msg.chat?.id) !== String(CHAT_ID)) return;

  const text = textOf(msg);
  if (!text) return;

  const parsed = parseReportText(text);

  // Nykterhetskontroller och fartkameror kastas tyst. Inget skickas, inget
  // loggas av texten.
  if (parsed?.intent === 'refused') return;
  if (!parsed || parsed.intent === 'clear') return;
  if (parsed.confidence < MIN_CONFIDENCE || !parsed.place) {
    console.log(`· hoppar över (${parsed.confidence.toFixed(2)}): ${text.slice(0, 60)}`);
    return;
  }

  // Telegrams date är sekunder sedan epoch. Rapporten ska leva från när den
  // skrevs, inte från när vi råkade läsa den — annars blir en gammal varning
  // ny igen efter en omstart.
  const createdAt = (msg.date ? msg.date * 1000 : Date.now());
  const ttl = (TTL_MINUTES[parsed.type] || 45) * 60000;
  const expiresAt = createdAt + ttl;
  if (expiresAt <= Date.now() + 60000) {
    console.log('· för gammalt, hoppar över:', text.slice(0, 60));
    return;
  }

  let hit;
  try {
    hit = await geocode(parsed.place);
  } catch (e) {
    console.warn('! geokodning misslyckades:', parsed.place, e.message);
    return;
  }
  if (!hit) { console.log('? okänd plats:', parsed.place, '—', text.slice(0, 60)); return; }

  // Primärnyckeln är slumpad med flit. Vore den härledd ur meddelande-id:t
  // skulle en omkörning krocka på både id och external_id samtidigt, och
  // Postgres ON CONFLICT kan bara tyst hoppa över det ena. Med slumpat id är
  // external_id enda krocken, och den är den vi vill ska vara tyst.
  const row = {
    id: randomUUID(),
    type: parsed.type,
    lat: hit.lat,
    lon: hit.lon,
    label: hit.label,
    note: text.slice(0, 240),
    source: 'facebook',                 // samma källa som gruppen, se schema.sql
    device_id: 'tg-bridge',
    external_id: `tg:${msg.chat.id}:${msg.message_id}`,
    created_at: createdAt,
    expires_at: expiresAt,
    confirms: 1,
    denials: 0,
  };

  if (DRY_RUN) {
    console.log('TORRKÖRNING:', row.type, row.label,
      `(${Math.round(parsed.confidence * 100)} %)`, '—', text.slice(0, 60));
    return;
  }

  try {
    const inserted = await insertReport(row);
    console.log(inserted ? '+ skapad:' : '= fanns redan:', row.type, row.label);
  } catch (e) {
    console.error('! kunde inte spara:', e.message);
  }
}

/* ================= Huvudloop ================= */

let backoff = 1000;

async function loop() {
  for (;;) {
    try {
      const updates = await getUpdates();
      backoff = 1000;

      for (const u of updates) {
        // Offset flyttas fram direkt. Ett meddelande som kraschar hanteringen
        // ska inte köras om i evighet och blockera allt efter det.
        state.offset = u.update_id + 1;
        const msg = u.message || u.channel_post;
        if (msg) {
          try { await handle(msg); }
          catch (e) { console.error('! fel i hanteringen:', e.message); }
        }
      }
      if (updates.length) saveState();

    } catch (e) {
      if (e.retryAfter) {                       // 429, Telegram säger vänta
        console.warn(`Väntar ${e.retryAfter} s på Telegrams begäran.`);
        await new Promise(r => setTimeout(r, e.retryAfter * 1000));
        continue;
      }
      if (/409/.test(e.message)) {
        console.error('409 Conflict — en annan instans pollar samma bot. Avslutar.');
        process.exit(1);
      }
      console.error('Nätverksfel:', e.message, `— försöker igen om ${backoff / 1000} s`);
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);   // upp till en minut, sedan platt
    }
  }
}

process.on('SIGINT', () => {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
  console.log('\nAvslutar. Offset sparad:', state.offset);
  process.exit(0);
});

console.log(`Polisvakt Telegram-brygga igång${DRY_RUN ? ' (torrkörning)' : ''}.`);
console.log(`Chatt: ${CHAT_ID || 'alla'} · offset: ${state.offset}`);
loop();
```

---

## 4. Kör den dygnet runt

### Linux (systemd)

`/etc/systemd/system/polisvakt-telegram.service`:

```ini
[Unit]
Description=Polisvakt Telegram-brygga
After=network-online.target

[Service]
Type=simple
User=polisvakt
WorkingDirectory=/opt/polisvakt
ExecStart=/usr/bin/node /opt/polisvakt/telegram-bridge.mjs
EnvironmentFile=/etc/polisvakt.env
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

`/etc/polisvakt.env` (läsbar bara för root, `chmod 600`):

```
TELEGRAM_TOKEN=8123456789:AAG-x9tK...
TELEGRAM_CHAT_ID=-1001234567890
SUPABASE_URL=https://livvehyqowmcafnisxho.supabase.co
SUPABASE_KEY=sb_publishable_6Oz7vhMd2b-kWB_DVftsmg_VwclVG5Q
```

```bash
sudo systemctl enable --now polisvakt-telegram
journalctl -u polisvakt-telegram -f
```

### Windows

Kör som en schemalagd uppgift som startar vid inloggning, med "Starta om vid
fel". Fungerar, men en dator som går i viloläge slutar polla — en billig VPS
eller en Raspberry Pi är bättre.

### Viktigt

Kör **bara en instans**. Två samtidiga `getUpdates` mot samma token ger
`409 Conflict` och båda tappar meddelanden. Har du testat lokalt: stäng ner
det innan servern startas.

---

## 5. Kontrollera kvaliteten

Kör `supabase/facebook.sql` en gång, sedan i SQL-editorn:

```sql
select * from facebook_recent;        -- allt som kommit in senaste dygnet
select * from facebook_quality;       -- hur mycket som röstas ner, per dag
```

Vad du letar efter första veckan:

- **Platser som blir fel.** Kolla `label` mot `note`. Blir "Erikslund" en
  parkering i Sala har geokodningen missat och platsen behöver ett alias i
  `data/aliases.vasteras.json`.
- **Nedröstade rapporter.** `denials` som klättrar betyder falska varningar.
  Höj `MIN_CONFIDENCE` innan du gör något annat.
- **Inget alls.** Nästan alltid integritetsläget i steg 2, inte skriptet.

---

## Vad bryggan medvetet inte gör

- **Läser inte bilder.** Ett fotograferat inlägg utan bildtext ger ingenting.
  OCR vore möjligt men fel prioritering.
- **Släcker inte varningar.** "Nu är dom borta" känns igen men används inte —
  vi vet inte vilken rapport det gäller, och att släcka fel varning är värre
  än att låta den löpa ut om en halvtimme.
- **Rapporterar aldrig nykterhets- eller drogkontroller.** Ligger i parsern och
  gäller alla vägar in. Ta inte bort det.
- **Rapporterar aldrig fartkameror.** De 136 kamerorna i Västmanland finns
  redan i appen med rätt position och mätriktning. En handmarkerad kamera
  hamnar några hundra meter fel, och det är sämre än ingen markering alls.
