# Deploya edge-funktionerna — efter att projektet är väckt

Fyra funktioner fick säkerhetsfixar i källan 2026-09-05 (se git 76dde9d, 3316bfa).
En fix i `supabase/functions/*` gäller **först när den deployas**. Projektet
måste vara aktivt (inte pausat) och CLI:n inloggad.

## 1. Logga in (engångs, görs av Elliot — jag rör aldrig token)

```bash
npx --yes supabase login
```

Öppnar en webbsida, tokenen hamnar i CLI:ns egen lagring. Alternativt
`SUPABASE_ACCESS_TOKEN` i miljön (aldrig i repot).

## 2. Deploya alla fyra

Kör från repo-roten (`polisvakt/`). `--project-ref` är Polisvarnare.

```bash
npx --yes supabase functions deploy stripe-webhook --project-ref livvehyqowmcafnisxho --no-verify-jwt
npx --yes supabase functions deploy send-reminder  --project-ref livvehyqowmcafnisxho --no-verify-jwt
npx --yes supabase functions deploy fbmejl-push    --project-ref livvehyqowmcafnisxho
npx --yes supabase functions deploy fbmejl-tom     --project-ref livvehyqowmcafnisxho
```

**Om `--no-verify-jwt`:** plattformens JWT-grind stoppar annars alla anrop som
inte bär en giltig Supabase-JWT. stripe-webhook anropas av Stripe (ingen JWT —
den verifierar Stripe-signaturen själv) och send-reminder av schemaläggaren
med `x-cron-secret` (grinden är nu STÄNGD utan hemlighet). fbmejl-push och
fbmejl-tom legitimerar med bearer service_role (JWT-form) och behöver INTE
flaggan — men skickar pg_cron `sb_secret_…`-formen måste även de deployas
med `--no-verify-jwt` (granskningsfynd: annars 401 varje minut, kön töms aldrig).

## 3. Hemligheter som MÅSTE finnas (Project → Edge Functions → Secrets)

| Funktion | Hemlighet | Utan den |
|---|---|---|
| send-reminder | `CRON_SECRET` | 503 — utskick vägras (var förr ÖPPET för alla) |
| send-reminder, fbmejl-push | `VAPID_KEYS` (hela JWK-JSON:et), `VAPID_SUBJECT` | 500 / pushar går inte |
| stripe-webhook | `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` | 500 |
| fbmejl-tom | `CRON_SECRET` eller bearer service_role | 401 |

## 4. Verifiera efter deploy

```bash
# Ska ge 503 (grinden stängd utan hemlighet) eller 401 (fel hemlighet) — ALDRIG 200:
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://livvehyqowmcafnisxho.supabase.co/functions/v1/send-reminder \
  -H "apikey: <anon-nyckeln ur js/config.js>" -H "Content-Type: application/json" -d '{"dry":true}'
```

Stripe: skicka en test-händelse från Stripe Dashboard → Webhooks → "Send test
event"; loggen ska visa `bokad` true/false, aldrig "tomt svar".

## 5. fbmejl-tom:s låsta import

`fbmejl-tom/index.ts` importerar brygglogiken från
`https://cdn.jsdelivr.net/gh/elliot851/polisvakt@63260bc/js/fbmejl.js`
(oföränderlig commit — inte den levande Pages-adressen). Ändras
`js/fbmejl.js`/`parser.js`/`store.js`/`util.js` i repot måste hashen bytas
HÄR och funktionen deployas om. Det är avsiktligt: backenden ska inte byta
beteende av en front-end-deploy.
