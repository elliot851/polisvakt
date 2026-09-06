# Deploya edge-funktionerna

Checklista. Följ den uppifrån och ned utan att hoppa — ordningen är vald så att
ingen funktion går live innan den hemlighet den lever på finns på plats.

Projekt: **Polisvarnare**, ref `livvehyqowmcafnisxho`.
Fyra funktioner: `stripe-webhook`, `send-reminder`, `fbmejl-push`, `fbmejl-tom`.

> **Vad som ändrades senast (2026-09-06, säkerhetsgranskning).**
> Alla fyra fick konstanttidsjämförelse av sina hemligheter, tak på kroppen de
> läser in, och felsvar som inte längre läcker interna felmeddelanden.
> `fbmejl-push` börjar dessutom använda avståndsgrinden — se steg 0 och steg 6.
> **En fix i `supabase/functions/*` gäller först när den är deployad.**

---

## Steg 0 — Innan du börjar

- [ ] Projektet är **aktivt**, inte pausat (Supabase pausar gratisprojekt).
      Öppna dashboarden och se att databasen svarar.
- [ ] SQL:en är körd. `supabase/schema.sql`, `billing.sql`, `stripe.sql`,
      `push.sql`, `fbmejl.sql`.
- [ ] **`supabase/migrationer/2026-08-22-notisradie.sql` är körd.** Utan den
      finns bara `fbmejl_push_mottagare(int)` och avståndsgrinden är inte
      möjlig. Funktionen kraschar inte — den faller tillbaka på "alla
      mottagare" och skriver en varning i loggen — men varje användare fortsätter
      då få notiser från hela landet oavsett vilken notisradie de valt i appen.

### Om mappen `_shared/`

`supabase/functions/_shared/grind.ts` innehåller den delade
konstanttidsjämförelsen. Mappar som börjar med understreck **deployas inte som
egna funktioner** — de buntas automatiskt in i de funktioner som importerar
dem. Försök alltså aldrig `deploy _shared`; det finns ingenting att deploya.

---

## Steg 1 — Logga in (engångs, görs av Elliot)

```bash
npx --yes supabase login
```

Öppnar en webbsida; tokenen hamnar i CLI:ns egen lagring. Alternativt
`SUPABASE_ACCESS_TOKEN` i miljön. **Aldrig i repot.**

Kontrollera att det tog:

```bash
npx --yes supabase projects list
```

`livvehyqowmcafnisxho` ska stå i listan.

---

## Steg 2 — Länka repot till projektet (engångs)

Kör från repo-roten (`polisvakt/`):

```bash
npx --yes supabase link --project-ref livvehyqowmcafnisxho
```

CLI:n frågar efter databaslösenordet. Det behövs bara för databaskommandon —
trycker du enter förbi det fungerar `functions deploy` ändå.

Kommandona i steg 4 bär `--project-ref` explicit, så de fungerar även om
länkningen inte gick igenom.

---

## Steg 3 — Hemligheter (namn, aldrig värden)

Sätts i **Dashboard → Project Settings → Edge Functions → Secrets**, eller med
`npx --yes supabase secrets set NAMN=...`. Hemligheter i Supabase är
**gemensamma för hela projektet**, inte per funktion.

Sätt dem **före** deploy. En funktion som startar utan sin hemlighet svarar
500 eller 503 tills den finns.

| Namn | Behövs av | Utan den |
|---|---|---|
| `STRIPE_SECRET_KEY` | stripe-webhook | 500 på varje leverans |
| `STRIPE_WEBHOOK_SECRET` | stripe-webhook | 500. **Test och live har OLIKA `whsec_…`** |
| `VAPID_KEYS` | send-reminder, fbmejl-push | 500. Hela JWK-JSON:et, inte base64-strängen |
| `VAPID_SUBJECT` | send-reminder, fbmejl-push | 500. `mailto:…` |
| `CRON_SECRET` | send-reminder, fbmejl-tom | send-reminder: **503, utskick vägras**. fbmejl-tom: 401 om inte service_role skickas i stället |
| `FBMEJL_ANROPSNYCKEL` | fbmejl-push | 401 om inte service_role skickas i stället. Minst **20 tecken**, annars räknas den inte (se steg 6) |
| `FB_GRUPP_ID` | fbmejl-tom | 500. Grupp-id ur länken `/groups/<gid>/…` |
| `FB_GRUPP` | fbmejl-tom | valfri reserv på gruppnamn när `FB_GRUPP_ID` saknas |
| `PV_APP_URL` | fbmejl-tom | valfri. Standard `https://polisvakt.pages.dev` |

`SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY` **injiceras av plattformen** och
ska inte sättas för hand.

### Generera de två som ska slumpas

```bash
# bash
npx --yes supabase secrets set CRON_SECRET="$(openssl rand -hex 24)"
npx --yes supabase secrets set FBMEJL_ANROPSNYCKEL="$(openssl rand -hex 24)"
```

```powershell
# PowerShell
$s = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
npx --yes supabase secrets set FBMEJL_ANROPSNYCKEL=$s
```

### `FBMEJL_ANROPSNYCKEL` måste stå på TVÅ ställen

Samma sträng, exakt, i båda ändarna:

1. som hemlighet **`FBMEJL_ANROPSNYCKEL`** på edge-funktionerna (versaler)
2. i **valvet** under namnet **`fbmejl_anropsnyckel`** (gemener) —
   Dashboard → Project Settings → Vault → New secret

`public.fbmejl_anropsnyckel()` i `supabase/fbmejl.sql` läser valvet och sätter
huvudet i `pg_net`-anropet. Glider de isär blir det `HTTP 401` i
`fbmejl_notis_logg`, varje gång, på en nyckel som ser rätt ut i båda ändarna.

Kontrollera vad som finns satt (**namn, inte värden** — `secrets list` visar
bara namn och en hash):

```bash
npx --yes supabase secrets list --project-ref livvehyqowmcafnisxho
```

---

## Steg 4 — Deploya, en funktion i taget

Kör från repo-roten.

```bash
npx --yes supabase functions deploy stripe-webhook --project-ref livvehyqowmcafnisxho --no-verify-jwt
```

```bash
npx --yes supabase functions deploy send-reminder --project-ref livvehyqowmcafnisxho --no-verify-jwt
```

```bash
npx --yes supabase functions deploy fbmejl-push --project-ref livvehyqowmcafnisxho --no-verify-jwt
```

```bash
npx --yes supabase functions deploy fbmejl-tom --project-ref livvehyqowmcafnisxho --no-verify-jwt
```

### Varför `--no-verify-jwt` på alla fyra

Plattformens JWT-grind avvisar varje anrop som inte bär en giltig Supabase-JWT
— **innan en enda rad av vår kod kör**. Det låter som ett extra lager, men för
de här fyra är det bara ett sätt att bli utelåst:

- **stripe-webhook** — Stripe skickar ingen JWT och kan inte göra det. Den
  legitimerar sig med `Stripe-Signature`, som verifieras mot
  `STRIPE_WEBHOOK_SECRET` innan kroppen används till någonting.
- **send-reminder** — schemaläggaren skickar `x-cron-secret`. Grinden är
  **stängd som förval**: saknas `CRON_SECRET` svarar funktionen 503 och skickar
  ingenting.
- **fbmejl-push** — bär `FBMEJL_ANROPSNYCKEL`, en slumpad sträng. Den är
  **inte** en JWT, så med grinden på blir det 401 varje minut och notiskedjan
  tystnar. Den som hellre kör på service_role-nyckeln (JWT-form) kan utelämna
  flaggan, men då är rotationen kopplad till hela projektets nyckel.
- **fbmejl-tom** — samma sak: pg_cron kan skicka `sb_secret_…`-formen, som inte
  heller är en JWT.

Alla fyra har egna, starkare lås i koden — se steg 6.

---

## Steg 5 — Verifiera efter deploy

**Ingen av kontrollerna nedan får ge 200.**

```bash
# send-reminder: 503 (CRON_SECRET saknas) eller 401 (fel hemlighet)
curl -s -o /dev/null -w "send-reminder %{http_code}\n" \
  -X POST https://livvehyqowmcafnisxho.supabase.co/functions/v1/send-reminder \
  -H "Content-Type: application/json" -d '{"dry":true}'

# fbmejl-push: 401
curl -s -o /dev/null -w "fbmejl-push %{http_code}\n" \
  -X POST https://livvehyqowmcafnisxho.supabase.co/functions/v1/fbmejl-push \
  -H "Content-Type: application/json" -d '{"dry":true}'

# fbmejl-tom: 401
curl -s -o /dev/null -w "fbmejl-tom %{http_code}\n" \
  -X POST https://livvehyqowmcafnisxho.supabase.co/functions/v1/fbmejl-tom \
  -H "Content-Type: application/json" -d '{}'

# stripe-webhook utan signatur: 400
curl -s -o /dev/null -w "stripe-webhook %{http_code}\n" \
  -X POST https://livvehyqowmcafnisxho.supabase.co/functions/v1/stripe-webhook \
  -H "Content-Type: application/json" -d '{}'
```

Sedan, med rätt hemlighet:

- [ ] **send-reminder** — samma anrop med `-H "x-cron-secret: <CRON_SECRET>"`
      ska ge 200 och en `{"dry":true,…}`-kropp **utan endpoints i svaret**.
- [ ] **fbmejl-push** — samma anrop med
      `-H "Authorization: Bearer <FBMEJL_ANROPSNYCKEL>"` och `{"dry":true}`
      ska ge 200 med `mottagare`, `platser` och `notis`, **utan endpoints**.
- [ ] **stripe-webhook** — Stripe Dashboard → Webhooks → *Send test event*.
      Loggen ska visa `bokad` true eller false, **aldrig** "tomt svar".
- [ ] **Funktionsloggen för fbmejl-push** ska ha en rad `Anropsgrind: N
      godtagen nyckel/nycklar av formen …` vid kallstart. Står det `0` där
      kommer varje anrop att nekas.

---

## Steg 6 — Fällor, i den ordning de brukar slå till

| Symptom | Orsak | Åtgärd |
|---|---|---|
| `fbmejl_notis_logg` säger `HTTP 401` varje gång | `FBMEJL_ANROPSNYCKEL` och valvets `fbmejl_anropsnyckel` är inte samma sträng | Sätt om båda från samma slumpning |
| Samma 401, men strängarna ÄR lika | Nyckeln är kortare än 20 tecken och filtreras bort. Loggen säger `…är satt men bara N tecken lång` | Slumpa en längre |
| Samma 401, nyckeln lång och lika | Funktionen deployades **utan** `--no-verify-jwt` — plattformens JWT-grind avvisar innan koden kör | Deploya om med flaggan |
| `nyckel_kalla` säger `fbmejl_anropsnyckel/valv` när du väntade dig service_role | En gammal hemlighet med det namnet ligger kvar i valvet och **vinner** | Ta bort den ur valvet, eller sätt `FBMEJL_ANROPSNYCKEL` till samma sträng |
| Loggen: `fbmejl_push_mottagare(int, jsonb) finns inte i databasen` | Notisradie-migrationen är inte körd | Kör `supabase/migrationer/2026-08-22-notisradie.sql`. Tills dess får alla notisen |
| send-reminder svarar 503 | `CRON_SECRET` saknas. **Avsiktligt** — grinden var förr öppen utan hemlighet | Sätt `CRON_SECRET` |
| Stripe-panelen full av röda leveranser med 400 | Fel `whsec_…` — test och live har olika | Kopiera rätt från endpointens sida i Stripe |
| Stripe-leveransen är grön men inget hände i databasen | Läs funktionsloggen. Svarskroppen är avsiktligt intetsägande sedan 2026-09-06; detaljen står bara i loggen och i `payment_events.error` |

---

## Steg 7 — `fbmejl-tom`:s låsta import

`fbmejl-tom/index.ts` importerar brygglogiken från

```
https://cdn.jsdelivr.net/gh/elliot851/polisvakt@63260bc/js/fbmejl.js
```

En **oföränderlig commit-hash**, inte den levande Pages-adressen. Ändras
`js/fbmejl.js`, `js/parser.js`, `js/store.js` eller `js/util.js` i repot måste
hashen bytas **här** och funktionen deployas om.

Det är avsiktligt: funktionen håller service_role-nyckeln, och backenden ska
inte kunna byta beteende av en front-end-deploy.
